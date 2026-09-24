/* Blue Aegis Guide — 共通スクリプト（blueaegis-site/script.js のフェードインのみ移植） */

/* スクロール連動フェードイン。
   セレクタは style.css 側と同一に保つこと（片方だけ変えると要素が消えたままになる）。 */
(function(){
  var SEL = 'section .lead, section .intro, .card, .domain, .offer,'
          + '.steps > li, .pol > div, .stat, .stat-note,'
          + '.faq dt, .faq dd, .scroller,'
          + '.message p, .message .pull,'
          + '.creed blockquote, .creed p, .mail, .bot,'
          + '.article p, .article h3, .article ul, .article .source, .postlist li';
  var els = document.querySelectorAll(SEL);
  var motionOK = window.matchMedia && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

  if (!motionOK || !('IntersectionObserver' in window)) {
    for (var i = 0; i < els.length; i++) els[i].classList.add('in');
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  for (var j = 0; j < els.length; j++) io.observe(els[j]);
})();
