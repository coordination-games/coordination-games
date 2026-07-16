interface TimberEnergyIconProps {
  size?: number;
  title?: string;
}

// Accessible inline SVG for the timber-to-energy conversion. A log/grain motif
// on the left, an energy bolt on the right, and an arrow between them carry the
// meaning by shape (never an emoji). Decorative by default (aria-hidden); pass
// a `title` to expose it as an img with an accessible name.
export function TimberEnergyIcon({ size = 18, title }: TimberEnergyIconProps) {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? title : undefined}
    >
      {labelled ? <title>{title}</title> : null}
      {/* Stacked timber logs. */}
      <ellipse cx="5" cy="8" rx="3.4" ry="1.7" />
      <path d="M1.6 8v3.2c0 .94 1.52 1.7 3.4 1.7s3.4-.76 3.4-1.7V8" />
      <line x1="5" y1="6.6" x2="5" y2="9.4" />
      {/* Conversion arrow. */}
      <line x1="9.6" y1="12" x2="14.4" y2="12" />
      <polyline points="12.8,10.2 14.8,12 12.8,13.8" />
      {/* Energy bolt. */}
      <polygon points="19,5 15.6,12.4 18.4,12.4 17,19 21,10.8 18.2,10.8" />
    </svg>
  );
}
