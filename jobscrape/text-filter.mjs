// text-filter.mjs — strips em-dashes from generated output text.
// colibri's LLM output (rankings, cover letters) can lean on em-dashes; this
// keeps every downstream artifact (digest, cards, drafts, PDFs, WhatsApp
// pushes) plain-hyphen instead. Applied at each output boundary rather than
// at generation time so it also catches literal em-dashes in this file's own
// static template strings.
export function stripEmDash(text) {
  if (typeof text !== "string") return text;
  return text.replace(/—/g, "-");
}
