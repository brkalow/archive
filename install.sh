#!/bin/bash
set -euo pipefail

# openctl installer
# Downloads and installs the latest openctl release for the current platform
#
# Environment variables:
#   INSTALL_DIR  - Installation directory (default: /usr/local/bin)
#   LOCAL_DIST   - Path to local dist directory for local installs

REPO_OWNER="brkalow"

# Print header
print_header() {
    local version="$1"
    echo ""
    echo -e "  \033[1;36mInstalling openctl CLI\033[0m"
    echo -e "  \033[0;90mVersion: ${version}\033[0m"
    echo ""
}
REPO_NAME="openctl"
BINARY_NAME="openctl"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
LOCAL_DIST="${LOCAL_DIST:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}==>${NC} $1"
}

warn() {
    echo -e "${YELLOW}warning:${NC} $1"
}

error() {
    echo -e "${RED}error:${NC} $1" >&2
    exit 1
}

# Detect OS
detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Darwin) echo "darwin" ;;
        Linux) echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *) error "Unsupported operating system: $os" ;;
    esac
}

# Detect architecture
detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *) error "Unsupported architecture: $arch" ;;
    esac
}

# Parse JSON tag_name from GitHub API response
parse_tag_name() {
    local json="$1"
    if command -v jq &> /dev/null; then
        echo "$json" | jq -r '.tag_name'
    else
        echo "$json" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
    fi
}

# Get the latest release version from GitHub API
get_latest_version() {
    local url="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
    local response version

    if command -v curl &> /dev/null; then
        response=$(curl -sL "$url")
    elif command -v wget &> /dev/null; then
        response=$(wget -qO- "$url")
    else
        error "Neither curl nor wget found. Please install one of them."
    fi

    version=$(parse_tag_name "$response")

    if [ -z "$version" ] || [ "$version" = "null" ]; then
        error "Failed to fetch latest version. Check your internet connection or if releases exist."
    fi

    echo "$version"
}

# Download a file
download() {
    local url="$1"
    local output="$2"

    if command -v curl &> /dev/null; then
        curl -fsSL "$url" -o "$output"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$output"
    else
        error "Neither curl nor wget found. Please install one of them."
    fi
}

# Compute SHA256 checksum of a file
compute_sha256() {
    local file="$1"
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        # No checksum tool available, skip verification
        echo ""
    fi
}

# Verify checksum of downloaded file
verify_checksum() {
    local file="$1"
    local checksums_file="$2"
    local filename
    filename=$(basename "$file")

    local expected actual
    expected=$(grep "$filename" "$checksums_file" 2>/dev/null | awk '{print $1}')

    if [ -z "$expected" ]; then
        warn "Checksum not found for ${filename}, skipping verification"
        return 0
    fi

    actual=$(compute_sha256 "$file")

    if [ -z "$actual" ]; then
        warn "No checksum tool available (sha256sum or shasum), skipping verification"
        return 0
    fi

    if [ "$expected" != "$actual" ]; then
        error "Checksum verification failed for ${filename}
  Expected: ${expected}
  Got:      ${actual}"
    fi

    info "Checksum verified"
}

# Install binary to INSTALL_DIR
install_binary() {
    local source_path="$1"
    local version_info="${2:-local}"

    # Check if we can write to INSTALL_DIR
    if [ ! -d "$INSTALL_DIR" ]; then
        mkdir -p "$INSTALL_DIR" 2>/dev/null || {
            warn "Cannot create ${INSTALL_DIR}, attempting with sudo..."
            sudo mkdir -p "$INSTALL_DIR"
        }
    fi

    info "Installing to ${INSTALL_DIR}..."

    if [ -w "$INSTALL_DIR" ]; then
        cp "$source_path" "${INSTALL_DIR}/${BINARY_NAME}"
        chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    else
        warn "Elevated permissions required to install to ${INSTALL_DIR}"
        sudo cp "$source_path" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    fi

    info "Successfully installed ${BINARY_NAME} ${version_info} to ${INSTALL_DIR}/${BINARY_NAME}"

    # Check if INSTALL_DIR is in PATH (use colon delimiters to avoid substring matches)
    if ! echo ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
        warn "${INSTALL_DIR} is not in your PATH"
        echo ""
        echo "Add it to your shell configuration:"
        echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi

    echo ""
    info "Run '${BINARY_NAME} --help' to get started"
}

# Install from local dist directory
install_local() {
    local os arch binary_path

    os=$(detect_os)
    arch=$(detect_arch)

    print_header "local"

    info "Installing from local dist: ${LOCAL_DIST}"
    info "Detected platform: ${os}-${arch}"

    binary_path="${LOCAL_DIST}/${BINARY_NAME}-${os}-${arch}"

    if [ ! -f "$binary_path" ]; then
        error "Binary not found: ${binary_path}"
    fi

    install_binary "$binary_path" "(local)"
}

# Install from GitHub releases
install_remote() {
    local os arch version archive_name download_url checksums_url tmp_dir

    os=$(detect_os)
    arch=$(detect_arch)

    # Windows uses zip, others use tar.gz
    if [ "$os" = "windows" ]; then
        archive_name="${BINARY_NAME}-${os}-${arch}.zip"
    else
        archive_name="${BINARY_NAME}-${os}-${arch}.tar.gz"
    fi

    version=$(get_latest_version)
    print_header "${version}"

    info "Detected platform: ${os}-${arch}"

    download_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${version}/${archive_name}"
    checksums_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${version}/checksums.txt"

    tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    # Download checksums file (optional, may not exist for older releases)
    info "Downloading checksums..."
    if ! download "$checksums_url" "${tmp_dir}/checksums.txt" 2>/dev/null; then
        warn "Checksums file not available, skipping verification"
        touch "${tmp_dir}/checksums.txt"
    fi

    info "Downloading ${archive_name}..."
    download "$download_url" "${tmp_dir}/${archive_name}"

    # Verify checksum
    verify_checksum "${tmp_dir}/${archive_name}" "${tmp_dir}/checksums.txt"

    info "Extracting..."

    if [ "$os" = "windows" ]; then
        unzip -q "${tmp_dir}/${archive_name}" -d "$tmp_dir"
    else
        tar -xzf "${tmp_dir}/${archive_name}" -C "$tmp_dir"
    fi

    install_binary "${tmp_dir}/${BINARY_NAME}" "${version}"
}

main() {
    if [ -n "$LOCAL_DIST" ]; then
        install_local
    else
        install_remote
    fi
}

main "$@"
