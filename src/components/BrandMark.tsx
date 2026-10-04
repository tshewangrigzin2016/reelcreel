export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="Reelcreel logo"
      className={className}
      fill="none"
    >
      <rect
        x="14.9"
        y="3.5"
        width="2.2"
        height="5"
        rx="1.1"
        fill="currentColor"
      />
      <circle cx="16" cy="4.2" r="1.8" fill="currentColor" />
      <circle
        cx="16"
        cy="17"
        r="9"
        stroke="currentColor"
        strokeWidth="2.6"
      />
      <path
        d="M7 17h18"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="13" cy="21" r="1.2" fill="currentColor" />
      <circle cx="19" cy="21" r="1.2" fill="currentColor" />
      <path
        d="M13.2 23.4q2.8 2 5.6 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
