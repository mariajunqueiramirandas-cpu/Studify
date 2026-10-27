// Grading references for essay.grade (spec 09 §7.6, ai-pipeline §8.4). Versioned with the task: any change here
// bumps essay.grade's version and requires re-running the calibration set (spec 09 ENM-05.10, §10).

/**
 * The five competências and their six levels, paraphrased from INEP's Cartilha do Participante (2025). Re-check
 * against each edition's cartilha before release.
 */
export const COMPETENCIA_DESCRIPTORS = [
  'Matriz de correção (5 competências, cada uma com nota em 0, 40, 80, 120, 160 ou 200):',
  '',
  'C1 — Domínio da modalidade escrita formal da língua portuguesa.',
  '- 200: excelente domínio; desvios gramaticais ou de convenção só como excepcionalidade, sem reincidência.',
  '- 160: bom domínio, com poucos desvios.',
  '- 120: domínio mediano, com alguns desvios.',
  '- 80: domínio insuficiente, com muitos desvios.',
  '- 40: domínio precário, com desvios diversificados e frequentes.',
  '- 0: desconhecimento da modalidade escrita formal.',
  '',
  'C2 — Compreender a proposta e aplicar conceitos de várias áreas para desenvolver o tema, dentro da estrutura do texto dissertativo-argumentativo em prosa.',
  '- 200: argumentação consistente com repertório sociocultural legitimado, pertinente e produtivo; excelente domínio do tipo textual.',
  '- 160: argumentação consistente; bom domínio do tipo, com proposição, argumentação e conclusão.',
  '- 120: argumentação previsível; domínio mediano do tipo textual.',
  '- 80: desenvolve o tema copiando trechos dos textos motivadores ou com domínio insuficiente do tipo (estrutura incompleta).',
  '- 40: tangencia o tema, ou domínio precário do tipo, com traços constantes de outros tipos textuais.',
  '- 0: fuga total ao tema ou não atendimento ao tipo dissertativo-argumentativo (zera a redação inteira).',
  '',
  'C3 — Selecionar, relacionar, organizar e interpretar informações, fatos, opiniões e argumentos em defesa de um ponto de vista.',
  '- 200: informações e argumentos relacionados ao tema de forma consistente e organizada, configurando autoria.',
  '- 160: relacionados ao tema e organizados, com indícios de autoria.',
  '- 120: limitados aos argumentos dos textos motivadores e pouco organizados.',
  '- 80: desorganizados ou contraditórios, limitados aos textos motivadores.',
  '- 40: pouco relacionados ao tema ou incoerentes, sem defesa de ponto de vista.',
  '- 0: não relacionados ao tema e sem defesa de ponto de vista.',
  '',
  'C4 — Conhecimento dos mecanismos linguísticos necessários para a construção da argumentação (coesão).',
  '- 200: articula bem as partes do texto, com repertório diversificado de recursos coesivos.',
  '- 160: articula as partes com poucas inadequações e repertório diversificado.',
  '- 120: articulação mediana, com inadequações e repertório pouco diversificado.',
  '- 80: articulação insuficiente, com muitas inadequações e repertório limitado.',
  '- 40: articulação precária.',
  '- 0: não articula as informações.',
  '',
  'C5 — Elaborar proposta de intervenção para o problema abordado, respeitando os direitos humanos.',
  '- Elementos: agente, ação, modo/meio, efeito/finalidade e detalhamento (de qualquer um deles).',
  '- 200: proposta muito bem elaborada, detalhada, relacionada ao tema e articulada à discussão (5 elementos).',
  '- 160: bem elaborada (4 elementos). 120: mediana (3). 80: insuficiente ou não articulada à discussão (2). 40: vaga ou precária (1).',
  '- 0: sem proposta, proposta não relacionada ao tema, ou proposta que desrespeita os direitos humanos (só a C5 fica com zero).',
].join('\n');

export interface EssayAnchor {
  /** "Cartilha 2025 — exemplo 1", "Professor(a) A — redação 7"… */
  label: string;
  theme: string;
  text: string;
  scores: readonly [number, number, number, number, number];
  justification: string;
}

/**
 * Calibrated anchor essays with official or teacher scores (3–5, roadmap calibration set). Empty until the owner
 * loads the calibration set: the grader then relies on the descriptors only, and results keep the "calibração
 * pendente" label (ENM-05.9).
 */
export const ESSAY_ANCHORS: readonly EssayAnchor[] = [];
