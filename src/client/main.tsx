import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupGlobals } from './globals';

// Set up global utilities (toast, clipboard) for backwards compatibility
setupGlobals();

// Mount React app
const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
