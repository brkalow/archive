import { useCallback } from 'react';

type ToastType = 'success' | 'error' | 'info';

/**
 * React hook for showing toast notifications.
 * Delegates to the global window.showToast function set up in globals.ts.
 */
export function useToast() {
  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    window.showToast?.(message, type);
  }, []);

  return { showToast };
}
