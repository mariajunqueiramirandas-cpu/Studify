// Landing for /c/{code}, /i/{code}, /q/{token}, /b/{pin} (SOC-09.4, S-EXT-03). Runs only when
// Android App Links did not open the app: the app is missing or the link was opened elsewhere.
(function () {
  var cfg = window.STUDIFY_SITE || {};
  var scheme = cfg.scheme || 'studify';
  var parts = location.pathname.split('/').filter(Boolean);
  var kind = parts[0];
  var value = decodeURIComponent(parts[1] || '').trim();

  // Same routes as the app's App Link redirects (mobile-app.md §2.3).
  var routes = {
    c: {
      title: 'Você foi convidado(a) para uma Turma',
      subtitle: 'Estude junto com a sua turma no Studify: materiais, quizzes e duelos.',
      label: 'Código da Turma',
      format: function (v) { return v.toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2'); },
      deep: function (v) { return scheme + '://class/join?code=' + encodeURIComponent(v.toUpperCase()); },
    },
    i: {
      title: 'Você ganhou um convite para o Studify',
      subtitle: 'O Studify transforma os PDFs das suas aulas em resumos, cartões e quizzes.',
      label: 'Código de convite',
      format: function (v) { return v.toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2'); },
      deep: function (v) { return scheme + '://auth/invite?code=' + encodeURIComponent(v.toUpperCase()); },
    },
    q: {
      title: 'Te desafiaram para um quiz!',
      subtitle: 'Abra no Studify para responder e comparar o resultado.',
      label: null,
      deep: function (v) { return scheme + '://quiz/shared/' + encodeURIComponent(v); },
    },
    b: {
      title: 'Entre na batalha ao vivo',
      subtitle: 'Abra o Studify e use o PIN para entrar na sala.',
      label: 'PIN da batalha',
      format: function (v) { return v; },
      deep: function (v) { return scheme + '://class/battle/join?pin=' + encodeURIComponent(v); },
    },
  };

  var route = routes[kind];
  var $ = function (id) { return document.getElementById(id); };

  if (!route || !value) {
    $('code-card').classList.add('hidden');
    $('open').classList.add('hidden');
  } else {
    document.title = route.title + ' · Studify';
    $('title').textContent = route.title;
    $('subtitle').textContent = route.subtitle;
    $('open').href = route.deep(value);
    if (route.label) {
      var shown = route.format(value);
      $('code-label').textContent = route.label;
      $('code').textContent = shown;
      $('copy').addEventListener('click', function () {
        var done = function () { $('copy').textContent = 'Copiado ✓'; };
        if (navigator.clipboard) navigator.clipboard.writeText(shown).then(done, function () {});
      });
    } else {
      $('code-card').classList.add('hidden');
    }
  }

  if (cfg.apkUrl) {
    $('download').href = cfg.apkUrl;
    $('download').classList.remove('hidden');
  }
})();
