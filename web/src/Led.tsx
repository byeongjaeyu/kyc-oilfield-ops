export function Led({ value, digits, label }: { value: number | null; digits: number; label: string }) {
  const lit = value == null ? '-'.repeat(digits) : String(value).padStart(digits, '0').slice(-digits);
  return (
    <span className="led" role="img" aria-label={`${label} ${value ?? '정보 없음'}`}>
      <span className="led-ghost" aria-hidden>
        {'8'.repeat(digits)}
      </span>
      <span className="led-lit" aria-hidden>
        {lit}
      </span>
    </span>
  );
}

