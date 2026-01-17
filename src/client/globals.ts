// Global utilities for backwards compatibility

type ToastType = 'success' | 'error' | 'info';

const TOAST_DURATION_MS = 3000;

function getToastClasses(type: ToastType): string {
  const baseClasses = 'fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-white text-sm font-medium z-50 transition-opacity duration-300';

  switch (type) {
    case 'success':
      return `${baseClasses} bg-green-600`;
    case 'error':
      return `${baseClasses} bg-red-600`;
    case 'info':
      return `${baseClasses} bg-accent-600`;
  }
}

function showToastImpl(message: string, type: ToastType = 'success'): void {
  const toast = document.createElement('div');
  toast.className = getToastClasses(type);
  toast.textContent = message;
  toast.style.opacity = '0';

  document.body.appendChild(toast);

  // Trigger reflow to enable transition
  void toast.offsetHeight;
  toast.style.opacity = '1';

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, TOAST_DURATION_MS);
}

// Header scroll border effect
function initHeaderScrollEffect(): void {
  const header = document.getElementById('site-header');
  if (!header) return;

  const updateBorder = () => {
    if (window.scrollY > 0) {
      header.classList.remove('border-transparent');
      header.classList.add('border-bg-elevated');
    } else {
      header.classList.remove('border-bg-elevated');
      header.classList.add('border-transparent');
    }
  };

  window.addEventListener('scroll', updateBorder, { passive: true });
  updateBorder();
}

export function setupGlobals(): void {
  window.copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToastImpl('Copied to clipboard', 'success');
    } catch (err) {
      console.error('Failed to copy:', err);
      showToastImpl('Failed to copy', 'error');
    }
  };

  window.showToast = (message: string, type: ToastType = 'success') => {
    showToastImpl(message, type);
  };

  // Initialize header scroll effect
  initHeaderScrollEffect();
}

declare global {
  interface Window {
    copyToClipboard: (text: string) => Promise<void>;
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  }
}
