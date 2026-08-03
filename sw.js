/* DayLog service worker — cache-first so the app works fully offline,
   plus best-effort daily reminder via Periodic Background Sync */
var CACHE = 'daylog-v6';
var ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE && k !== 'daylog-settings'; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function(hit){
      var fetched = fetch(e.request).then(function(res){
        if(res && res.ok){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        }
        return res;
      }).catch(function(){ return hit; });
      return hit || fetched;
    })
  );
});

/* ---------- daily reminder ---------- */
function maybeRemind(){
  return caches.open('daylog-settings').then(function(c){
    return c.match('settings').then(function(res){
      if(!res) return;
      return res.json().then(function(s){
        if(!s || !s.rem) return;
        var now = new Date();
        var parts = (s.remTime || '20:00').split(':');
        var target = (+parts[0]) * 60 + (+parts[1]);
        if(now.getHours() * 60 + now.getMinutes() < target) return;   // not yet time today
        var today = now.getFullYear() + '-' +
          (now.getMonth()+1 < 10 ? '0' : '') + (now.getMonth()+1) + '-' +
          (now.getDate() < 10 ? '0' : '') + now.getDate();
        return c.match('last-remind').then(function(last){
          var check = last ? last.text() : Promise.resolve('');
          return check.then(function(prev){
            if(prev === today) return;                                 // already reminded today
            return c.put('last-remind', new Response(today)).then(function(){
              return self.registration.showNotification('DayLog', {
                body: 'Time to check today’s routine and to-dos.',
                icon: 'icon-192.png',
                badge: 'icon-192.png',
                tag: 'daylog-daily'
              });
            });
          });
        });
      });
    });
  }).catch(function(){});
}

self.addEventListener('periodicsync', function(e){
  if(e.tag === 'daily-reminder') e.waitUntil(maybeRemind());
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(ws){
      if(ws.length) return ws[0].focus();
      return clients.openWindow('./');
    })
  );
});
