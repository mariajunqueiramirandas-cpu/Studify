// Injection defense for student answers, peer text, Turma names and other user data
// (security-privacy §8.1). The payload is wrapped in a tag and any attempt to close or
// reopen that tag inside the payload is neutralized, so it cannot break out of the data block.

export const TAG = {
  resposta: 'resposta_do_aluno',
  comentario: 'comentario_denuncia',
  texto: 'texto_para_moderar',
  contribuicao: 'contribuicao',
  pergunta: 'pergunta_do_colega',
  trecho: 'trecho_selecionado',
  material: 'material_do_estudo',
} as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function neutralizeTag(tag: string, content: string): string {
  const pattern = new RegExp(`<(\\/?\\s*${escapeRegExp(tag)})`, 'gi');
  return content.replace(pattern, '&lt;$1');
}

export function wrapUntrusted(tag: string, content: string): string {
  return `<${tag}>\n${neutralizeTag(tag, content)}\n</${tag}>`;
}
