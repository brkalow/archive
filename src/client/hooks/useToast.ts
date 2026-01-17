import { useCallback } from 'react';

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

export function useToast() {
  const showToast = useCallback((message: string, type: ToastType = 'success') => {
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
  }, []);

  return { showToast };
}
