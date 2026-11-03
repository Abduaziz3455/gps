// Apply the saved theme before first paint (no flash). Classic script: runs before the CSS-dependent body.
try { var t = localStorage.getItem('tbb_theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked */ }
