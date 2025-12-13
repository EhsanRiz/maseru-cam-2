// Service Worker for Maseru Bridge Traffic Bot PWA
const CACHE_NAME = 'traffic-bot-v1';
const OFFLINE_URL = '/';

// Files to cache for offline use
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('🔔 Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('🔔 Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.log('Cache failed, continuing anyway:', err);
        return self.skipWaiting();
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('🔔 Service Worker activated');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('🔔 Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => clients.claim())
  );
});

// Fetch event - network first, cache fallback
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip API calls - always go to network
  if (event.request.url.includes('/api/')) return;
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clone and cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request)
          .then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // Return offline page for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match(OFFLINE_URL);
            }
            return new Response('Offline', { status: 503 });
          });
      })
  );
});

// Push notification received
self.addEventListener('push', (event) => {
  console.log('🔔 Push notification received');
  
  let data = {
    title: '🌉 Maseru Bridge Traffic',
    body: 'Traffic conditions have changed',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'traffic-alert',
    data: { url: '/' }
  };
  
  try {
    if (event.data) {
      const pushData = event.data.json();
      data = { ...data, ...pushData };
    }
  } catch (e) {
    console.log('Could not parse push data:', e);
  }
  
  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    tag: data.tag,
    vibrate: [200, 100, 200],
    data: data.data,
    actions: [
      { action: 'view', title: '👀 View' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ],
    requireInteraction: false,
    renotify: true
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('🔔 Notification clicked:', event.action);
  event.notification.close();
  
  if (event.action === 'dismiss') {
    return;
  }
  
  const urlToOpen = event.notification.data?.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // If app is already open, focus it
        for (const client of clientList) {
          if ('focus' in client) {
            client.postMessage({ type: 'notification-click', data: event.notification.data });
            return client.focus();
          }
        }
        // Otherwise open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Handle notification close
self.addEventListener('notificationclose', (event) => {
  console.log('🔔 Notification closed');
});

// Message handler for communication with main app
self.addEventListener('message', (event) => {
  console.log('🔔 Service Worker received message:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
