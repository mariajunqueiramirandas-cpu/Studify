# Studify — PT-BR Copy Guide

| | |
|---|---|
| **Status** | Draft v1 |
| **Scope** | Voice and tone, terminology, formatting rules and the key UI strings of the Android app. Every UI string lives in `apps/mobile/i18n/pt-BR.json`; keys below are suggested names for that file. |
| **Related** | [UX guidelines](ux-guidelines.md) · [User flows](../product/user-flows.md) · [PRD glossary](../product/PRD.md#8-glossary) · spec §5 sections in [docs/specs](../specs/) |

When a spec's §5 string and this guide disagree, **this guide wins** for wording. The spec still owns behavior. The [Harmonized strings](#9-harmonized-strings) section lists the spec lines to update.

---

## 1. Voice and tone

**Studify talks like a friendly older classmate who is good at studying:** informal, encouraging, direct, never preachy.

| Principle | Do | Don't |
|---|---|---|
| **Informal "você"** | "Você tem 34 cartões pra revisar." | "O usuário possui 34 cartões." / "Tu tens…" |
| **Encouraging, never shaming** | "Não foi dessa vez. A certa é a **C**." | "Errado!" / "Você errou de novo." |
| **Effort over talent** | "Mandou bem! Você revisou 18 cartões." | "Você é um gênio!" |
| **Concrete** | "Faltam 3 dias pra prova de Biologia." | "Sua prova está chegando!" |
| **Honest about AI** | "Correção estimada pela IA — seu professor(a) pode corrigir diferente." | "Sua nota será 8,0." |
| **Short** | One idea per sentence; buttons ≤ 3 words. | Paragraphs in toasts. |
| **Calm at night and before exams** | "Dormir bem ajuda sua memória a fixar o que você estudou." | "Só mais 10 minutinhos!" after 22:00. |
| **Age-appropriate** | Light slang that teens use and teachers accept: "bora", "mandou bem", "tá", "pra", "rapidinho". | Heavy slang, memes, profanity, irony, sarcasm, flirting tone. |

### 1.1 Who is speaking

| Speaker | Person | Example |
|---|---|---|
| **The app** (system UI, AI features that act for the student: reading, generating, grading, planning) | **First person singular, "eu"** | "Lendo seu material…" · "Criei um cartão pra você não esquecer disso." · "Reorganizei seu plano." |
| **The Turma** (human moderation in a shared subject) | Third person, "a turma" | "Valeu! A turma vai conferir." |
| **The Studify team** (privacy notice, legal, support, global moderation) | "a equipe do Studify" | "A equipe do Studify vai analisar sua denúncia." |
| **Characters** (Lucas, Bia & Caio, Advogado do Diabo, Capi) | Their own voice, in character; spoken lines may be more colloquial ("Isso não tá no seu material") | "E aí! Faltei na aula de Osmose 😅 Me explica?" |

Never mix "eu" and "a gente / nós" for the app in the same screen.

### 1.2 Grammar conventions

- **"pra"** in buttons and casual copy ("Revisar pra prova", "Segure pra falar"). **"para"** in legal, privacy, permission rationales and official ENEM/school texts.
- **"tá" / "tô"** only in casual sentences, never in buttons, errors or legal text.
- **Imperatives:** casual instructions use the colloquial form ("Tira uma foto", "Confere se…"). Buttons use the infinitive ("Tirar foto", "Revisar agora"). Official notices may use the standard form ("Confira sempre o edital oficial do Inep"). Keep one form per screen.
- **Gender-neutral by default.** Prefer neutral constructions ("Que bom te ver!" instead of "Bem-vindo"). Use "professor(a)" when the gender is unknown, or the teacher's name without an article when it is known ("provas antigas de {teacher}"). Achievements with adjectives use "(a)": "Calibrado(a)".
- **No exclamation stacking** ("!!") and no ALL CAPS, except "NÃO" when quoting a question stem.

## 2. Formatting rules

| Item | Rule | Examples |
|---|---|---|
| Short date | `dd/mm` | 14/11 |
| Date with weekday | `ddd, dd/mm`, weekday lowercase abbreviation | qua, 14/11 |
| Long date | `d de mmmm` (year only if not the current one) | 14 de novembro · 3 de fevereiro de 2027 |
| Weekdays | seg, ter, qua, qui, sex, sáb, dom (full: segunda, terça, quarta…) | |
| Relative dates | hoje, amanhã, ontem, em 3 dias; countdowns as below | "Faltam 3 dias" · "É amanhã!" · "Hoje às 14:00" |
| Time in fields and lists | 24 h `HH:mm` | 19:00 · 07:30 |
| Time in sentences | `às 19h`, `às 19h30` | "Foco até 15h40" |
| Durations | `25 min`, `1h30`, approximate with `≈` | ≈ 8 min |
| Decimal separator | comma | 7,5 · 62,5% |
| Thousands separator | dot | 1.250 cartões |
| Percent | no space | 62% |
| School grades (0–10) | one decimal, school's rounding step (GOL-06.4) | 7,0 · 6,5 |
| School grades (0–100) | integer | 75 |
| Grade ranges | "entre X e Y" | "Previsão de nota: entre 6,5 e 8,0" |
| ENEM scores | integer, with interval | "Nota estimada (TRI): 642 (entre 610 e 675)" |
| Ordinals | º / ª | 1º lugar · 2º bimestre · 3ª série |
| Page references | 📄 p. N / p. N–M | 📄 p. 12 · 📄 p. 12–14 |
| Counts | numerals always | "3 cartões", not "três cartões" |
| Money | **never shown to students** (AI usage is shown as % of the limit) | "Você usou 80% do seu limite de IA de hoje." |
| Capitalization | Sentence case for titles and buttons. Feature names are proper nouns and keep their capitals (Caderno de Erros, Modo Véspera, Mapa da Memória, Feed de Estudos, Câmera Mágica, Prova Provável, Meta SISU, Ensine o Lucas, Treino de Argumentação, Podcast Interativo). Common nouns stay lowercase in running text: matéria, turma, prova, simulado. | "Entrar numa turma" · "Abrir o Caderno de Erros" |
| Emojis | At most one per message, at the end. Never in errors, legal, privacy, distress or safety copy. Allowed: 🎉 ✅ 🍀 🎯 🔥 🛡️ 📚 🎧 😴 🌙 💪 ✨ 🏆 ⚔️ 🤝 😅 😉 🧘 🏁 💤 (📄 ✋ ⚑ are UI symbols) | "Meta batida! 🎉" |

## 3. Terminology

Canonical terms appear exactly like this in the UI. The code name links to the [domain model](../engineering/architecture.md#3-domain-model).

| Canonical PT-BR | Code name | Don't use | Notes |
|---|---|---|---|
| Matéria / matérias | `subject` | disciplina, curso | |
| Material | `document` | documento, upload | "arquivo" only in file errors |
| Mapa da matéria | knowledge map | árvore, índice, sumário | |
| Unidade · Tópico · Conceito | `knowledge_node.kind` | capítulo, assunto, item | |
| Resumo rápido · Resumo · Aprofundado | `notes.depth` | anotação, nota | **"nota" is reserved for grades** |
| Glossário · termo | `glossary_terms` | dicionário | |
| Cartão / cartões | `card` | flashcard, ficha | "cartões de memória (flashcards)" allowed once in onboarding/help |
| Revisão / revisar | review | repetição, estudar de novo | |
| Errei · Difícil · Bom · Fácil | FSRS ratings | De novo, Again | 2-button variant: Errei · Lembrei |
| Questão | `question` | exercício (except in Problemas), pergunta | "pergunta" = what the student asks the tutor |
| Quiz | `quiz` (practice) | teste | |
| Simulado | `quiz` (`mock_exam`) | prova simulada, teste | |
| Prova | `exam` | teste, exame, avaliação | "avaliação" ok inside grading-rule presets |
| Semana de Provas | goal mode `exam_week` | semana de testes | |
| Objetivo | `goal` | meta | **"meta" = a numeric target**: Meta do dia, Meta de lembrança, Meta SISU, Meta do grupo |
| Conteúdo da prova | exam scope | escopo, matéria da prova | |
| Não cai na prova | excluded topic | ignorar, remover | |
| Plano | plan | cronograma, agenda | "calendário de provas" = school exam schedule (ING-07) |
| Sessão | `study_session` | aula | |
| Caderno de Erros | `mistakes` | lista de erros, histórico de erros | |
| Não sabia · Confundi · Desatenção · Li errado | mistake causes | burrice, falta de atenção | |
| Nota · média · recuperação | grades | pontuação (school) | ENEM uses "nota estimada" |
| Prontidão | readiness | preparo | "Prontidão: 72%" |
| Domínio | `mastery` | nível, XP | "nível" = XP level |
| Previsão de nota | predicted grade | nota prevista, garantia | Always with "É uma estimativa, não uma garantia." |
| Turma | `class_group` | grupo, sala, classe | Tab label "Turma"; lowercase in running text |
| Quem organiza a turma / organizador(a) | owner | dono, admin | |
| Moderador(a) | moderator | admin | |
| Sala de estudo | `study_rooms` | sala (alone), chamada | |
| Duelo · Batalha ao vivo | `duel` · `battle` | partida, game | |
| Reportar erro | `content_flags` | avisar erro, denunciar | ⚑ icon; for **content** mistakes |
| Denunciar | `user_reports` | reportar | For **abuse** (people, names, harmful AI output) |
| Bloquear | `user_blocks` | banir | "banir" is a moderator-only action, shown as "Remover da turma" |
| Tutor | tutor | chatbot, assistente, "a IA" as a name | |
| Conhecimento geral | general-knowledge answer | internet, fora do contexto | Badge on ungrounded answers |
| Gerado por IA | AI disclosure | feito por robô | Required on AI content (SP-10) |
| Macete | mnemonic | mnemônico | Feature name stays "Estúdio de Mnemônicos" |
| Sequência | `streaks` | streak, ofensiva | |
| Escudo | streak freeze | congelamento | |
| Meta do dia | daily goal | | Minutes |
| XP · nível · conquista | `xp_events`, `achievements` | medalha, troféu, pontos | |
| Horário silencioso | quiet hours | não perturbe | "Não perturbe" = the Android system setting |
| Limite de IA | budget (PLT-04) | créditos, saldo, moedas | |
| Material removido | missing source | arquivo deletado | |
| Linguagens · Humanas · Natureza · Matemática · Redação | ENEM areas `LC` `CH` `CN` `MT` `RED` | LC, CH… in UI | Full names in UI; codes only in compact charts with a legend |
| Habilidade H1–H30 | `enem_skills` | competência (for skills) | Matriz de Referência term |
| Competência 1–5 (C1–C5 in compact views) | redação competências | Competência I–V | Arabic numerals in the UI for readability |
| Nota estimada (TRI) | TRI estimate | nota oficial, nota real | Always with the footnote (ENM-04.10) |
| Cartão-resposta | answer sheet | gabarito (= answer key) | |
| Gabarito | answer key | resposta oficial | |
| Nota de corte · peso | SISU cut-off · weight | nota mínima (that's a different SISU concept) | |
| Repertório | `repertorio_items` | referências | |
| Proposta de intervenção | ENEM C5 | solução | |
| Reta Final | ENM-10 | contagem regressiva | |

## 4. Key strings by area

Placeholders use `{name}`. Markdown bold (`**…**`) is allowed in strings rendered by the content renderer.

### 4.1 Navigation and global

| Key | String |
|---|---|
| `tab.today` | Hoje |
| `tab.subjects` | Matérias |
| `tab.practice` | Praticar |
| `tab.class` | Turma |
| `tab.profile` | Perfil |
| `global.ask_tutor` | Perguntar |
| `global.ai_generated` | Gerado por IA |
| `global.report_error` | ⚑ Reportar erro |
| `global.report_abuse` | Denunciar |
| `global.undo` | Desfazer |
| `global.retry` | Tentar de novo |
| `global.coming_soon` | Em breve |
| `global.skip_for_now` | Pular por enquanto |
| `global.done` | Pronto |
| `global.cancel` | Cancelar |
| `global.page_chip` | 📄 p. {page} |
| `global.source_removed` | Material removido |
| `global.source_class_only` | Material disponível só para a turma |

### 4.2 Onboarding and account

| Key | String |
|---|---|
| `auth.title` | Envie o material da aula. Receba um sistema de estudos completo. |
| `auth.google` | Entrar com Google |
| `auth.email` | Entrar com e-mail |
| `auth.code.title` | Enviei um código pro seu e-mail. Digite aqui: |
| `auth.code.generic` | Se este e-mail estiver cadastrado, você vai receber um código. |
| `auth.offline` | Você precisa de internet pra entrar pela primeira vez. |
| `onb.invite.title` | Tem um código de convite? |
| `onb.invite.hint` | Peça pra quem organiza a sua turma ou pra quem te chamou pro Studify. |
| `onb.invite.invalid` | Código inválido ou expirado. Peça um novo pra quem organiza a turma. |
| `onb.age.title` | Quando você nasceu? |
| `onb.age.under12` | A Studify é para estudantes a partir de 12 anos. |
| `onb.guardian.title` | Qual é o e-mail do seu responsável? |
| `onb.guardian.why` | Para quem tem menos de 16 anos, o Studify avisa seu responsável e ele pode acompanhar seu tempo de estudo. Suas respostas e anotações continuam só suas. |
| `onb.profile.name` | Como você quer ser chamado(a)? |
| `onb.profile.school_year` | Em que ano você está? |
| `onb.intent.title` | Pra que você vai estudar? |
| `onb.intent.exam_week` | Semana de Provas |
| `onb.intent.enem` | ENEM |
| `onb.intent.one_subject` | Só quero estudar uma matéria |
| `onb.first_subject.title` | Qual matéria você quer estudar primeiro? |
| `onb.first_subject.later` | Fazer isso depois |
| `perm.notifications` | Quer que eu avise quando seu material estiver pronto? |
| `perm.camera` | Para tirar fotos de páginas e questões, o Studify precisa da câmera. As fotos ficam só com você, a não ser que você compartilhe com a turma. |
| `perm.mic` | Para conversar por voz, preciso do microfone. O áudio não sai do seu celular — só o texto. |
| `update.required` | Tem uma versão nova do Studify. Atualize pra continuar. |

> `onb.guardian.why` speaks for the service ("o Studify") rather than as "eu", because it describes a policy, not something the app does in the moment. The guardian step is Phase 2 and its required/recommended status is an open owner decision (security-privacy SP-03).

### 4.3 Upload, outline and progress

| Key | String |
|---|---|
| `upload.button` | Adicionar material |
| `upload.kinds` | Slides · Apostila / anotações · Livro · Prova antiga · Conteúdo da prova |
| `upload.share_sheet` | Salvar em qual matéria? |
| `upload.progress` | Enviando… {pct}% |
| `ingest.reading` | Lendo seu material… |
| `ingest.mapping` | Montando o mapa da matéria… |
| `ingest.outline_ready` | Pronto! Esse é o mapa da sua matéria. Deu certo? Você pode ajustar. |
| `ingest.generating` | Gerando resumos e cartões… {done} de {total} tópicos |
| `ingest.merged` | Juntei o novo material ao mapa: {n_new} tópicos novos, {n_updated} atualizados. |
| `ingest.kind_confirm` | Isso parece ser **{kind}**. Tá certo? |
| `ingest.not_study` | Hmm, isso não parece material de estudo. Quer usar mesmo assim? |
| `ingest.duplicate` | Você já enviou esse material nessa matéria. |
| `ingest.password` | Esse PDF tem senha. Tira a senha e envia de novo. |
| `ingest.corrupt` | Não consegui abrir esse arquivo. Ele pode estar corrompido — tenta baixar de novo. |
| `ingest.too_large` | Esse arquivo é grande demais (máx. 100 MB). Tenta dividir em partes. |
| `ingest.too_many_pages` | Esse PDF tem mais de 1.000 páginas. Envia só os capítulos que você precisa. |
| `ingest.failed` | Algo deu errado ao ler o material. |
| `ingest.ready_push` | Seu material de {matéria} está pronto 📚 |
| `outline.actions` | Renomear · Juntar com… · Dividir aqui · Mover para… · Nova unidade · Apagar · Não cai na prova |
| `outline.read_only` | Só quem organiza a turma pode mudar o mapa. Você ainda pode marcar o que não cai na sua prova. |
| `notes.not_ready` | Ainda estou escrevendo esse resumo… ({done} de {total} tópicos prontos) |
| `notes.retrieval` | Agora tenta lembrar |
| `notes.retrieval.cta` | Responder 3 perguntas rápidas |
| `notes.explain` | Explica de outro jeito |
| `notes.explain.styles` | Mais simples · Com uma analogia · Com um exemplo · Passo a passo |
| `viewer.scanned` | Página escaneada — o destaque pode não aparecer. |

### 4.4 Review (cartões)

| Key | String |
|---|---|
| `review.today` | Você tem **{n} cartões** pra revisar (≈ {min} min) |
| `review.start` | Revisar agora |
| `review.reveal` | Mostrar resposta |
| `review.rating.again` | Errei |
| `review.rating.hard` | Difícil |
| `review.rating.good` | Bom |
| `review.rating.easy` | Fácil |
| `review.rating.remembered` | Lembrei |
| `review.tag.exam` | Reforço pra prova · {matéria} em {n} dias |
| `review.tag.new` | Novo |
| `review.done` | Sessão concluída! 🎉 Você revisou {n} cartões em {min} min. |
| `review.leech` | Esse cartão tá difícil de fixar. Quer reescrever, criar um macete ou ver uma explicação diferente? |
| `review.recovery` | Acumulou bastante revisão ({n}). Bora espalhar em {d} dias? (Modo recuperação) |
| `review.edit_shared` | Essa edição vale só pra você. Quer sugerir a correção pra turma? |
| `review.all_done_widget` | Tudo revisado por hoje ✨ |
| `review.notification` | {n} cartões quase esquecendo. 1 minutinho? |

### 4.5 Quizzes, simulados and feedback

| Key | String |
|---|---|
| `quiz.confirm` | Confirmar |
| `quiz.skip` | Pular |
| `quiz.mark` | Marcar pra revisar |
| `quiz.confidence.title` | Quão confiante você está? |
| `quiz.confidence.levels` | Chutando · Acho que sim · Bem confiante · Certeza |
| `quiz.correct` | Acertou! ✅ |
| `quiz.wrong` | Não foi dessa vez. A certa é a **{letter}**. |
| `quiz.why_wrong` | Por que a {letter} está errada: |
| `quiz.partial` | Quase! Você acertou {k} de {n}. |
| `quiz.typo` | Aceitei, mas confere a grafia: *{word}*. |
| `quiz.card_toast` | Criei um cartão pra você não esquecer disso. · Ver cartão · Não precisa |
| `sim.start` | Começar simulado |
| `sim.mode.exam` | Modo prova |
| `sim.mode.relaxed` | Modo tranquilo |
| `sim.time_left` | Tempo restante: {mm:ss} |
| `sim.submit` | Entregar |
| `sim.submit_confirm` | Tem certeza que quer entregar? Ainda faltam {n} questões e {m} estão marcadas pra revisar. |
| `sim.result` | Você acertou {k} de {n} — nota estimada **{grade}** |
| `grading.progress` | Corrigindo… |
| `grading.sections` | O que você acertou · O que faltou · Como ficaria nota máxima |
| `grading.disclaimer` | Correção estimada pela IA — seu professor(a) pode corrigir diferente. |
| `grading.dispute` | Eu discordo da correção |
| `grading.offline` | Vou corrigir quando você tiver internet. |

### 4.6 Caderno de Erros and Medidor de Confiança

| Key | String |
|---|---|
| `mistakes.title` | Caderno de Erros |
| `mistakes.cause.title` | Por que você errou? |
| `mistakes.cause.options` | Não sabia · Confundi · Desatenção · Li errado |
| `mistakes.stat` | {p}% dos seus erros são {cause} |
| `mistakes.resolved` | Resolvido 🎉 |
| `mistakes.learned` | O que eu aprendi |
| `mistakes.retry` | Refazer erros |
| `mistakes.contrast` | Você confundiu **{a}** com **{b}**. Olha a diferença: |
| `mistakes.slow` | Calma: lê de novo antes de confirmar. |
| `mistakes.misread` | Atenção ao **NÃO** no enunciado. |
| `calibration.insight` | Quando você diz "Certeza" em {topic}, acerta só {p}%. |

### 4.7 Tutor

| Key | String |
|---|---|
| `tutor.disclosure` | Você está conversando com uma IA. Ela pode errar — confira sempre a página citada. |
| `tutor.empty` | Pergunta qualquer coisa sobre o seu material. Eu respondo mostrando a página de onde tirei. |
| `tutor.placeholder` | Pergunte sobre {matéria}… |
| `tutor.modes` | Responder · Socrático · Me testa |
| `tutor.scope` | Falando sobre: {escopo} |
| `tutor.followups` | Explica mais simples · Me dá um exemplo · Me testa sobre isso · Criar cartão |
| `tutor.give_up` | Desisto, me mostra |
| `tutor.not_in_material` | Isso não está no seu material de {matéria}. |
| `tutor.nearest` | O mais perto que encontrei: {tópico} |
| `tutor.general_cta` | Responder com conhecimento geral |
| `tutor.general_badge` | Conhecimento geral — não está no seu material. Confira com seu professor(a). |
| `tutor.processing` | Ainda estou lendo seu material ({pct}%). Posso responder com o que já li. |
| `tutor.limit_warning` | Você ainda tem {n} perguntas hoje. |
| `tutor.limit_reached` | Seu limite de perguntas de hoje acabou. Volta amanhã! Enquanto isso, que tal revisar seus cartões? |
| `tutor.offline` | Sem internet. O tutor precisa de conexão — seus cartões funcionam offline. |
| `tutor.interrupted` | Resposta interrompida |
| `tutor.long_thread` | Essa conversa ficou longa. Continuar numa nova? Eu levo um resumo. |
| `tutor.homework` | Não vou fazer o trabalho por você, mas te ajudo a fazer: quer começar pelo esboço? |
| `tutor.hold_to_talk` | Segure pra falar |
| `ai.refusal` | Não consigo ajudar com isso aqui. Quer perguntar de outro jeito? |

### 4.8 Hoje, planner and Semana de Provas

| Key | String |
|---|---|
| `today.summary` | Hoje: {minutes} min · {subjects} matérias |
| `today.start` | Começar sessão |
| `today.continue` | Continuar sessão |
| `today.quick` | Só tenho {n} minutos |
| `today.no_goal` | Tem prova chegando? Crie sua Semana de Provas e eu monto o plano. |
| `goal.new.title` | Pra que você vai estudar? |
| `goal.wizard.exams.title` | Quando são suas provas? |
| `exam.add` | Adicionar prova |
| `exam.time.tbd` | Horário a definir |
| `scope.title` | O que vai cair? |
| `scope.hint` | Tira uma foto da lista de conteúdo ou cola o texto que o professor(a) mandou. |
| `scope.result` | Encontrei {matched} de {total} tópicos no seu material. |
| `scope.unmatched` | Não encontrei no seu material: {items}. Quer enviar o material ou pedir pra turma? |
| `scope.default_all` | Sem conteúdo definido — vou considerar a matéria toda. Adicione o conteúdo pra um plano mais certeiro. |
| `time.title` | Quanto tempo você consegue estudar por dia? |
| `time.presets` | Leve · Médio · Puxado |
| `plan.ready` | Seu plano está pronto! 🎯 |
| `plan.reason` | {Matéria} hoje porque a prova é {weekday} e você está com {mastery}% em {topic}. |
| `plan.replanned` | Reorganizei seu plano: {summary}. |
| `plan.tight` | Tá apertado! Pra caber tudo, eu encurtei: {items}. Quer aumentar seu tempo diário? |
| `countdown.days` | Faltam {n} dias |
| `countdown.tomorrow` | É amanhã! |
| `countdown.today` | Hoje às {time} |
| `readiness.label` | Prontidão: {pct}% |
| `predict.range` | Previsão de nota: entre {low} e {high} |
| `predict.label` | É uma estimativa, não uma garantia. |
| `material.missing` | Sem material ainda |
| `material.ask_class` | Pedir material pra turma |

### 4.9 Quanto preciso tirar? and Modo Véspera

| Key | String |
|---|---|
| `grade.title` | Quanto preciso tirar? |
| `grade.need` | Você precisa de {grade} na {exam} pra fechar o {term} com {target}. |
| `grade.need.uniform` | Se você tirar a mesma nota em tudo que falta, precisa de {grade}. |
| `grade.secured` | Você já garantiu a média! Mas bora manter o ritmo 😉 |
| `grade.impossible` | Mesmo tirando {max} não dá pra fechar com {target}. Na recuperação, você precisaria de {rec}. |
| `grade.ask` | Como foi a prova de {Matéria}? Já saiu a nota? |
| `vespera.notify` | Amanhã tem prova de {Matéria}. Bora revisar o essencial em {minutes} min? |
| `vespera.steps` | Resumo de uma página · Revisão relâmpago · Cartões que você errou · Seus erros · Checklist |
| `vespera.not_studied` | Não deu tempo de estudar esse — foca no básico. |
| `vespera.sleep` | Dormir bem ajuda sua memória a fixar o que você estudou. Que tal parar às {time}? |
| `exam.good_luck` | Boa prova! 🍀 |
| `desperate.offer.title` | Prova em {n} dias? Bora pro Modo Desespero 😅 |
| `desperate.offer.body` | Calma, dá pra fazer muita coisa. Eu foco no que mais vale ponto e monto um plano de ataque pra você. |
| `desperate.diag.body` | Umas perguntas rápidas pra eu saber o que você já sabe. Sem nota, sem pressão. |
| `desperate.coverage` | Com {hours} por dia, dá pra cobrir ~{pct}% do que deve cair. |
| `desperate.groups` | Foco total · Só o básico · Fica de fora |
| `desperate.enough` | Você já fez bastante hoje. Descansar também conta. |

> **Modo Desespero tone.** The name is the student's own joke ("bateu o desespero"); everything inside the mode is calm and concrete. Never "você deixou pra última hora", never countdown alarms. Full string list in [spec 07 §5.3](../specs/07-goals-semana-de-provas.md#53-key-pt-br-strings).

### 4.10 Turma, duels and battles

| Key | String |
|---|---|
| `class.create` | Criar turma |
| `class.name.placeholder` | Ex.: 2º A — Colégio Estadual |
| `class.join` | Entrar numa turma |
| `class.join.hint` | Digite o código ou escaneie o QR |
| `class.join.pending` | Pedido enviado! Agora é só esperar a aprovação de quem organiza a turma. |
| `class.requests` | {n} pedidos para entrar · Aprovar todos · Recusar |
| `class.invite.whatsapp` | Bora estudar junto no Studify? 📚 Entra na nossa turma *{nome}*: {link} (código: {código}) |
| `class.share_subject` | Compartilhar com a turma? Todo mundo da turma vai poder ver e estudar esta matéria. O seu progresso continua só seu. |
| `class.leave` | Sair da turma · Você vai perder acesso às matérias da turma. Quer fazer uma cópia pessoal antes? |
| `class.budget` | A turma está perto do limite de IA deste mês. |
| `class.insight.hard` | Difícil para a turma |
| `class.insight.pct` | {p}% da turma erra essa |
| `class.insight.trap` | A pegadinha mais comum: {p}% marcaram {letra} |
| `duel.challenge` | Desafiar pra um duelo ⚔️ |
| `duel.invite_push` | {nome} te desafiou num duelo de {matéria}! |
| `duel.your_turn` | Sua vez! |
| `duel.win` | Você venceu! 🏆 |
| `duel.loss` | Foi por pouco! Revanche? |
| `duel.tie` | Empate! 🤝 |
| `duel.expired` | Esse duelo expirou. |
| `duel.opt_out` | Não quero receber desafios |
| `battle.title` | Batalha ao vivo |
| `battle.pin` | PIN da batalha: {pin} |
| `battle.waiting` | Esperando a galera entrar… |
| `battle.start` | Começar |
| `battle.podium` | Pódio 🏆 |
| `battle.place` | Você ficou em {n}º! |
| `share.quiz` | Compartilhar desafio |
| `share.quiz.card` | Fiz {acertos}/{total} em {matéria} — consegue bater? |
| `block.done` | Você não vai mais receber desafios de {nome}. |

### 4.11 Reportar erro (TRU-02)

| Key | String |
|---|---|
| `flag.title` | O que tá errado? |
| `flag.reasons` | Informação errada · Gabarito errado · Confuso · Não está no material · Erro de digitação/formatação · Conteúdo impróprio · Outro |
| `flag.thanks.personal` | Valeu! Vou conferir. |
| `flag.thanks.shared` | Valeu! A turma vai conferir. |
| `flag.confirmed` | Você tinha razão! Corrigi: {fix} |
| `flag.not_error` | Conferi no material e parece certo: |
| `flag.actions` | Aplicar correção · Editar · Remover item · Ocultar mesmo assim · Manter |
| `flag.in_review` | Em revisão |
| `flag.fixed` | Corrigido ✓ |
| `flag.propagated` | {n} itens que você estudou foram corrigidos. |

### 4.12 Feed de Estudos

| Key | String |
|---|---|
| `feed.open` | Abrir o Feed |
| `feed.swipe_hint` | Arrasta pra cima pra próxima |
| `feed.card.tap` | Toque pra ver a resposta |
| `feed.card.swipe` | ← Errei · Lembrei → |
| `feed.did_you_know` | Você sabia? |
| `feed.checkpoint` | Mandou bem! Você revisou **{c} cartões**, acertou **{k} de {n}** questões e aprendeu **{l} conceitos** em {min} min. |
| `feed.stop` | Parar por aqui |
| `feed.more` | Mais 5 minutos |
| `feed.break` | Você já tá há quase meia hora. Seu cérebro guarda melhor com pausas — bora dar um tempo? |
| `feed.daily_limit` | Hoje você já estudou 45 min no Feed. Que tal um simulado ou descansar? |
| `feed.bedtime` | Já tá tarde 😴 Dormir bem também é estudar — a memória se fixa durante o sono. |
| `feed.empty` | Você zerou o Feed de hoje! 🎉 Volta amanhã ou faz um simulado. |
| `feed.offline` | Sem internet — o Feed continua funcionando. |

### 4.13 Câmera Mágica

| Key | String |
|---|---|
| `cam.title` | Câmera Mágica ✨ |
| `cam.intent.title` | O que você quer fazer? |
| `cam.intents` | Me explica · Resolver questão · Adicionar à matéria · Corrigir minha resposta |
| `cam.quality.blur` | A foto ficou tremida. Bora tirar outra? |
| `cam.quality.dark` | Tá escuro demais pra ler. |
| `cam.quality.glare` | Tem reflexo de luz em parte da página. |
| `cam.quality.skew` | A página ficou torta — tenta alinhar. |
| `cam.quality.use_anyway` | Usar mesmo assim |
| `cam.partial` | Parte da questão ficou de fora da foto. · Tirar outra · Continuar assim |
| `cam.multiple` | Achei {n} questões nessa foto. Qual você quer? |
| `cam.hint` | Me ajuda a resolver · Dica {i} de {n} · Mais uma dica · Tentar responder · Ver resolução completa |
| `cam.correct` | Boa! Você acertou 🎉 |
| `cam.not_yet` | Ainda não. Quer mais uma dica? |
| `cam.not_in_material` | Isso não está no seu material, mas aqui vai uma explicação geral: |
| `cam.after` | Praticar parecidas · Salvar questão · Criar cartões disso · Perguntar mais |
| `cam.faces_blurred` | Rostos na foto foram desfocados para proteger a privacidade. |
| `cam.shared_warning` | Todo mundo da turma vai ver essas fotos. |
| `cam.transcription.title` | Confere se eu li certo |
| `cam.transcription.rule` | Corrija só o que eu li errado — não vale melhorar o texto 😉 |
| `cam.transcription.confirm` | Confirmar e corrigir |
| `cam.transcription.edited` | Transcrição editada por você |
| `cam.no_content` | Não achei conteúdo de estudo nessa foto. |
| `cam.offline` | Sem internet agora — eu processo assim que você conectar. |
| `cam.legibility` | {n} trechos ficaram difíceis de ler — na prova, letra legível evita perder pontos. |

### 4.14 Podcast, Lucas and Argumentação

| Key | String |
|---|---|
| `podcast.title` | Podcast Interativo 🎧 |
| `podcast.generate` | Gerar episódio |
| `podcast.styles` | Resumão · Aprofundado · Revisão pra prova |
| `podcast.recording` | Seu episódio tá sendo gravado… eu aviso quando ficar pronto 🎧 |
| `podcast.ready` | Seu episódio tá pronto 🎧 |
| `podcast.cached` | Já existe um episódio da turma sobre isso. Ouvir agora? |
| `podcast.download` | Baixar pra ouvir offline |
| `podcast.sources` | Fontes |
| `podcast.ask` | ✋ Perguntar |
| `podcast.ask.type` | Ou digite sua pergunta |
| `podcast.resume` | Voltando ao episódio… |
| `podcast.pause_think` | Pausa pra pensar… {s} |
| `lucas.title` | Ensine o Lucas |
| `lucas.opening` | E aí! Faltei na aula de {tópico} 😅 Me explica? |
| `lucas.thinking` | Lucas está pensando… |
| `lucas.end` | Terminar aula |
| `lucas.score` | Quanto o Lucas entendeu: {n}/100 |
| `lucas.bands` | O Lucas ficou mais confuso 😅 · Tá quase! · Mandou bem! · Nasceu pra ensinar! 🏆 |
| `lucas.gaps` | Pontos que ficaram faltando |
| `lucas.errors` | O Lucas aprendeu errado: |
| `arg.title` | Treino de Argumentação |
| `arg.thesis` | Qual é a sua tese? |
| `arg.modes` | Debate · Construir argumento |
| `arg.opponent` | Advogado do Diabo |
| `arg.round` | Rodada {i} de {n} |
| `arg.fallacy` | Falácia detectada: {nome} |
| `arg.repertorio` | Repertório geral · Do seu material |
| `arg.blocked_theme` | Esse tema não dá pra debater aqui. Que tal outro? |

### 4.15 ENEM

| Key | String |
|---|---|
| `enem.goal.title` | ENEM {ano} |
| `enem.dates.provisional` | Datas ainda não divulgadas pelo Inep — usando {data} como previsão. |
| `enem.language` | Qual língua estrangeira você vai fazer? |
| `enem.areas` | Linguagens · Humanas · Natureza · Matemática · Redação |
| `enem.skill.practice` | Praticar essa habilidade |
| `bank.source` | ENEM {ano} · {dia}º dia · Questão {n} · Fonte: Inep |
| `bank.annulled` | Questão anulada pelo Inep |
| `bank.solution` | Resolução comentada pelo Studify |
| `sim.enem.modes` | Dia 1 completo · Dia 2 completo |
| `sim.enem.answer_sheet` | Cartão-resposta |
| `sim.enem.time_warning` | Faltam {min} minutos |
| `sim.enem.paused` | Simulado com pausa |
| `sim.enem.score` | Nota estimada (TRI) |
| `sim.enem.footnote` | Estimativa do Studify. A nota oficial do Inep pode ser diferente. |
| `sim.enem.easy_misses` | Você errou {n} questões fáceis pro seu nível — elas pesam mais na TRI. |
| `sim.enem.lucky_hits` | {n} acertos parecem chute. Na TRI, eles valem menos. |
| `sim.enem.blank` | Nunca deixe em branco: em branco conta como erro. |
| `sim.enem.stuck` | Você travou aqui ({min} min). Na prova, pule e volte depois. |
| `red.theme.pick` | Me dá um tema |
| `red.lines` | {n} de 30 linhas |
| `red.too_short` | Com até 7 linhas, a redação leva nota zero. |
| `red.grading` | Corrigindo sua redação… te aviso quando ficar pronta. |
| `red.proposta` | Agente · Ação · Meio/modo · Finalidade · Detalhamento |
| `red.hr.zero` | Essa proposta desrespeita os direitos humanos: a Competência 5 fica com zero. |
| `red.repertorio.unverified` | Não consegui confirmar essa referência. Confira antes de usar. |
| `red.weekly_limit` | Você já usou suas {n} correções desta semana. Na segunda tem mais! |
| `sisu.title` | Meta SISU |
| `sisu.cutoff.note` | Nota de corte é só referência — ela muda a cada edição. |
| `sisu.gap` | Você está a {x} pontos da meta. |
| `sisu.manual` | Não achou? Digite os pesos e a nota de corte do edital. |
| `atual.title` | Atualidades da semana |
| `atual.save` | Salvar como repertório |
| `pp.title` | Prova Provável |
| `pp.disclaimer` | Provável, não garantido. Baseado em {n} provas antigas de {teacher}. |
| `ppe.theme.disclaimer` | Tema de treino — ninguém sabe o tema real do ENEM. |
| `final.start` | Começou a Reta Final! 🏁 |
| `final.checklist.note` | Confira sempre o edital oficial do Inep. |
| `final.good_luck` | Boa prova! Documento e caneta preta transparente na mochila? 🍀 |

### 4.16 Errors, offline and limits

| Key | String |
|---|---|
| `error.generic` | Algo deu errado. Tenta de novo? |
| `error.generation` | Algo deu errado ao preparar isso. |
| `error.network` | Não consegui me conectar. Confere sua internet e tenta de novo. |
| `error.rate_limited` | Calma! Tenta de novo em instantes. |
| `error.not_found` | Não encontrei isso. Pode ter sido apagado. |
| `error.permission` | Você não tem permissão pra fazer isso nessa turma. |
| `offline.banner` | Sem internet — revisões e resumos baixados continuam funcionando. |
| `offline.ai_disabled` | Isso precisa de internet. |
| `offline.queued` | Salvei aqui. Sincronizo quando a internet voltar. |
| `sync.pending` | {n} revisões aguardando sincronização |
| `budget.user_daily` | Seu limite de IA de hoje acabou. O que não precisa de IA continua funcionando — e eu continuo o resto amanhã. |
| `budget.upload_paused` | Seu limite de IA de hoje acabou. O material fica salvo e eu continuo amanhã. |
| `budget.usage` | Você usou {p}% do seu limite de IA de hoje. |
| `budget.global` | A IA do Studify está pausada por hoje. Seus cartões e resumos continuam aqui. |
| `regenerate.limit` | Você já refez esse resumo 3 vezes hoje. Tenta amanhã! |

### 4.17 Motivation, wellbeing and notifications

| Key | String |
|---|---|
| `goal.daily` | Meta do dia: {n} min |
| `goal.daily.done` | Meta batida! 🎉 |
| `streak.count` | Sequência: {n} dias 🔥 |
| `streak.shield_earned` | Você ganhou um escudo 🛡️! Se um dia você não conseguir estudar, ele protege sua sequência. |
| `streak.shield_used` | Seu escudo protegeu sua sequência ontem 🛡️ |
| `streak.rest_day` | Dia de descanso 😌 |
| `streak.reset` | Sua sequência recomeçou. Seu recorde de {n} dias continua aqui — bora de novo, no seu ritmo 💪 |
| `xp.gain` | +{n} XP |
| `xp.level_up` | Subiu pro nível {n}! 🎉 |
| `achievement.new` | Nova conquista: {nome} |
| `focus.title` | Modo foco |
| `focus.until` | Foco até {hh:mm} |
| `focus.break` | Pausa! Levanta, bebe água, alonga 🧘 |
| `burnout.long_session` | Já faz 50 minutos direto. Que tal uma pausa de 5? 🧘 |
| `burnout.late` | Tá tarde! Dormir bem ajuda a lembrar tudo amanhã 🌙 |
| `burnout.heavy_week` | Essa semana tá puxada. Quer deixar os próximos dias mais leves? |
| `help.card` | Precisa conversar? O CVV atende de graça, 24 horas, pelo 188 ou no chat em cvv.org.br. Em emergência, ligue 192. |

**Achievement names** (catalog in [spec 13 §8.5](../specs/13-motivation-wellbeing.md#85-achievement-catalog-v1)): Primeiro material · Primeira revisão · 7 / 30 / 100 dias · 100 / 1.000 cartões · 500 questões · Primeiro simulado · Caçador de chefões · Caderno limpo · Calibrado(a) · Nasceu pra ensinar · Bom de argumento · Duelista · Revanche! · Líder da turma · Caçador de erros · Foco total · Semana vencida · Semana consistente.

### 4.18 Notification copy rules

| Rule | Detail |
|---|---|
| **Never in quiet hours** (default 22:00–07:00) | Messages due inside quiet hours move to 07:00 or are dropped if stale (e.g. "Batalha começando"). |
| **Evening cut-offs** | Streak and review reminders never after 20:00. Modo Véspera default 19:00. |
| **Max 3 unrequested per day** | Requested reminders don't count (mobile-app §5.3). |
| **One idea, ≤ 80 characters in the title** | Title says what, body says how long. |
| **No guilt, no loss framing** | ✅ "Que tal 5 minutinhos de revisão hoje? 📚" · ❌ "Você vai perder sua sequência!" |
| **Exam days** | Only "Boa prova! 🍀" in the morning, no study content (GOL-07.7, ENM-10.6). |

| Channel | Example |
|---|---|
| `reviews` | "{n} cartões quase esquecendo. 1 minutinho?" |
| `plan` | "Plano de hoje: {min} min · {n} matérias" · "Amanhã tem prova de {Matéria}. Bora revisar o essencial em {minutes} min?" |
| `class` | "{nome} te desafiou num duelo de {matéria}!" · "Batalha começando! Entra com o PIN {pin}" · "Material novo na turma: {matéria}" |
| `processing` | "Seu material de {matéria} está pronto 📚" · "Seu episódio tá pronto 🎧" · "Sua redação foi corrigida" |

## 5. Do and don't

| Situation | ✅ Do | ❌ Don't |
|---|---|---|
| Wrong answer | "Não foi dessa vez. A certa é a **C**." | "Errado! Preste mais atenção." |
| Many mistakes from carelessness | "40% dos seus erros são desatenção. Lê o enunciado com calma." | "Você é desatento." |
| Missed plan day | "Reorganizei seu plano: Química foi pra quinta." | "Você não estudou ontem 😢" |
| Streak reset | "Sua sequência recomeçou. Seu recorde continua aqui." | "Você perdeu sua sequência de 12 dias!" |
| AI uncertainty | "É uma estimativa, não uma garantia." | "Você vai tirar 8,0." |
| Content not in material | "Isso não está no seu material de Biologia." | Answering silently from general knowledge |
| Late at night | "Já tá tarde 😴 Dormir bem também é estudar." | "Só mais um pouquinho!" |
| Limit reached | "Seu limite de IA de hoje acabou… eu continuo o resto amanhã." | "Compre mais créditos." / "Erro 402" |
| Teacher reference | "Confira com seu professor(a)." | "Confira com sua professora." (when the gender is unknown) |
| Error | "Não consegui abrir esse arquivo. Tenta baixar de novo." | "Error: PDF_PARSE_FAILED" |
| Comparison | "{p}% da turma erra essa." | "A Ana acertou e você não." |
| Homework | "Te ajudo a fazer: quer começar pelo esboço?" | Handing over a finished assignment |

## 6. Accessibility copy

- Every icon-only control needs a label: "Abrir página 12 do material", "Marcar pra revisar", "Tirar foto".
- Announce results in live regions: "Resposta certa" / "Resposta errada. A certa é a C."
- Don't encode meaning only in emojis: "Acertou! ✅" works without the emoji.
- Timers announce at 1 minute and 10 seconds left, not every second.

## 7. Placeholders and plurals

- Use ICU plural rules in `pt-BR.json`: `{n, plural, one {# cartão} other {# cartões}}`. Portuguese uses the singular for 0 in some contexts; prefer rephrasing zero states ("Nenhum cartão pra revisar agora" → better: "Tudo revisado por hoje ✨").
- Placeholders for names are never translated or capitalized by code. `{Matéria}` (capital M) means the subject name as written by the user.

## 8. Review checklist for new strings

1. Uses the canonical term from §3?
2. Correct speaker (§1.1)?
3. Formatting rules (§2): dates, decimals, page chips?
4. ≤ 3 words for buttons; one idea per toast?
5. No shame, no loss framing, no guarantee?
6. Emoji count ≤ 1 and allowed?
7. Works at 200% font scale (no truncation of the key part)?

## 9. Harmonized strings

These spec strings differ from the canonical wording above. Update the spec's §5 (and any matching text elsewhere in the spec) to the new string.

| # | Spec location | Current | Canonical | Reason |
|---|---|---|---|---|
| H-01 | [04 §5](../specs/04-flashcards-memory.md#5-ux-and-screens) Flag | "Esse cartão tem erro? Avisar" | "Achou um erro nesse cartão? ⚑ Reportar erro" | One verb for content errors (TRU-02) |
| H-02 | [06 §5](../specs/06-feed-de-estudos.md#5-ux-and-screens) Item menu | "Avisar erro" | "Reportar erro" | Same as H-01 |
| H-03 | [06 §5](../specs/06-feed-de-estudos.md#5-ux-and-screens) Question feedback | "Quase! A certa é a **B**." | "Não foi dessa vez. A certa é a **B**." | "Quase!" is reserved for partial credit (spec 05) |
| H-04 | [03 §5](../specs/03-tutor.md#5-ux-and-screens) Me testa verdicts | "Certo! ✅" | "Acertou! ✅" | Same feedback wording everywhere |
| H-05 | [01 §5](../specs/01-ingestion-knowledge-map.md#5-ux-and-screens) Background progress | "Gerando resumos e flashcards…" | "Gerando resumos e cartões…" | "Cartão" is the canonical term |
| H-06 | [01 §5](../specs/01-ingestion-knowledge-map.md#5-ux-and-screens) Viewer | "Criar flashcard daqui" | "Criar cartão daqui" | Same as H-05 |
| H-07 | [02 §5](../specs/02-learn-notes.md#5-ux-and-screens) Selection menu, Glossary, topic mock | "Criar flashcard" · "Já está nos seus flashcards" · "[Flashcards (14)]" | "Criar cartão" · "Já está nos seus cartões" · "Cartões (14)" | Same as H-05 |
| H-08 | [03 §5](../specs/03-tutor.md#5-ux-and-screens) Follow-up chips | "Criar flashcard" | "Criar cartão" | Same as H-05 |
| H-09 | [03 §5](../specs/03-tutor.md#5-ux-and-screens) Voice | "Segure para falar" | "Segure pra falar" | "pra" in buttons (§1.2); matches spec 12 |
| H-10 | [03 §5](../specs/03-tutor.md#5-ux-and-screens) General badge | "…Confira com seu professor." | "…Confira com seu professor(a)." | Gender-neutral (§1.2) |
| H-11 | [03 §5](../specs/03-tutor.md#5-ux-and-screens) Thread mock | inline "📄21", "📄23" | "📄 p. 21", "📄 p. 23" | Page chip format (§2) |
| H-12 | [05 §5](../specs/05-practice-exams.md#5-ux-and-screens) Card toast | "Criamos um cartão pra você não esquecer disso." | "Criei um cartão pra você não esquecer disso." | App speaks as "eu" (§1.1) |
| H-13 | [05 §5](../specs/05-practice-exams.md#5-ux-and-screens) Disclaimer | "Correção estimada pela IA — sua professora pode corrigir diferente." | "Correção estimada pela IA — seu professor(a) pode corrigir diferente." | Gender-neutral |
| H-14 | [05 §5](../specs/05-practice-exams.md#5-ux-and-screens) Offline AI | "Vamos corrigir quando você tiver internet." | "Vou corrigir quando você tiver internet." | "eu" voice |
| H-15 | [10 §5.2](../specs/10-turma-social.md#5-ux-and-screens) Flag | "Valeu! A gente vai conferir." · "Você tinha razão! Corrigimos: …" · "Conferimos no material e parece certo:" · "Corrigimos {n} itens que você estudou." | "Valeu! Vou conferir." (personal) / "Valeu! A turma vai conferir." (shared) · "Você tinha razão! Corrigi: …" · "Conferi no material e parece certo:" · "{n} itens que você estudou foram corrigidos." | Speaker rules (§1.1); matches TRU-02.5–02.6 |
| H-16 | [10 §5.2](../specs/10-turma-social.md#5-ux-and-screens) Duel | "Desafiar para um duelo ⚔️" | "Desafiar pra um duelo ⚔️" | "pra" in buttons |
| H-17 | [11 §5.3](../specs/11-camera-magica.md#5-ux-and-screens) Transcription | "Confere se a gente leu certo" · "Corrija só o que a gente leu errado…" | "Confere se eu li certo" · "Corrija só o que eu li errado…" | "eu" voice |
| H-18 | [11 §5.3](../specs/11-camera-magica.md#5-ux-and-screens) Errors | "Sem internet agora — a gente processa assim que conectar." | "Sem internet agora — eu processo assim que você conectar." | "eu" voice |
| H-19 | [12 §5.2](../specs/12-interactive-learning.md#5-ux-and-screens) Podcast | "…a gente avisa quando ficar pronto 🎧" | "…eu aviso quando ficar pronto 🎧" | "eu" voice. Hosts' spoken lines ("Isso não tá no seu material") stay colloquial |
| H-20 | [09 §5](../specs/09-enem-mode.md#5-ux-and-screens) `red.hr.zero` | "…a Competência V fica com zero." | "…a Competência 5 fica com zero." | Arabic numerals for competências in the UI (§3) |
| H-21 | [09 §5](../specs/09-enem-mode.md#5-ux-and-screens) `red.repertorio.unverified` | "Não conseguimos confirmar essa referência." | "Não consegui confirmar essa referência." | "eu" voice |
| H-22 | [08 §5](../specs/08-prova-provavel.md#5-ux-and-screens) `pp.disclaimer` | "…provas antigas do(a) {teacher}." | "…provas antigas de {teacher}." | Name without a gendered article (§1.2) |
| H-23 | [mobile-app §5.3](../engineering/mobile-app.md#53-limits-and-quiet-hours-protective-by-default) Permission | "Quer que a gente avise quando seu material estiver pronto?" | "Quer que eu avise quando seu material estiver pronto?" | "eu" voice |
| H-24 | [07 §5.3](../specs/07-goals-semana-de-provas.md#53-key-pt-br-strings) `scope.hint` | "…o texto que o professor mandou." | "…o texto que o professor(a) mandou." | Gender-neutral |
