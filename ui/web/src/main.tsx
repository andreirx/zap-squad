import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { requestPersistentStorage } from './lib/idb';

// Request persistent storage to prevent browser eviction of IndexedDB data.
// Without this, Firefox may delete user data under storage pressure.
// Chrome grants persistence automatically for frequently visited sites.
requestPersistentStorage().then(granted => {
  if (granted) {
    console.log('[zap-squad] persistent storage granted');
  } else {
    console.warn('[zap-squad] persistent storage denied — user data may be evicted under storage pressure');
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
