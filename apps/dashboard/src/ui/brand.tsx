// The Studify mark for the painel: the app icon (Capi over the open book), the same file as the favicon.
export function BrandMark({ size = 34 }: { size?: number }) {
  return <img className="brand-mark" src="/painel/favicon.svg" width={size} height={size} alt="" />;
}

export function BrandText() {
  return (
    <span>
      <span className="brand-name">Studify</span>
      <span className="brand-sub"> painel</span>
    </span>
  );
}
