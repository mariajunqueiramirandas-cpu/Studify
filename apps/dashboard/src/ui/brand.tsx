// The Studify mark for the painel: the open book with a highlighter stroke, in the theme's colors.
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--primary)" />
      <path d="M7 10.5c3-1.4 6-1.2 9 .8 3-2 6-2.2 9-.8v12c-3-1.4-6-1.2-9 .8-3-2-6-2.2-9-.8z" fill="var(--sheet)" />
      <path d="M16 11.3v12" stroke="var(--primary)" strokeWidth="1.4" />
      <path d="M9.5 15.5h4.5" stroke="#F2B33D" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function BrandText() {
  return (
    <span>
      <span className="brand-name">Studify</span>
      <span className="brand-sub"> painel</span>
    </span>
  );
}
