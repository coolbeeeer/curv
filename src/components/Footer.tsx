/**
 * Site footer, styled after the curv-ui spec.
 * Docs points at the FAQ page, which is the current user documentation.
 * Terms, Privacy and Risks link to the legal pages every real product needs.
 */
import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="sc-page-foot sc-reference-footer">
      <span>
        curv <i>© 2026 All rights reserved</i>
      </span>
      <div className="sc-footer-socials" aria-label="curv social channels">
        <span>Follow curv</span>
        <a
          href="https://x.com/Curvpad"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="curv on X"
        >
          <b>X</b>
        </a>
        <b>Discord</b>
        <b>Telegram</b>
      </div>
      <span>
        <Link href="/faqs" prefetch={false}>
          <b>Docs</b>
        </Link>
        <Link href="/terms" prefetch={false}>
          <b>Terms</b>
        </Link>
        <Link href="/privacy" prefetch={false}>
          <b>Privacy</b>
        </Link>
        <Link href="/risks" prefetch={false}>
          <b>Risks</b>
        </Link>
        <Link href="/music" prefetch={false}>
          <b>AI Music Studio</b>
        </Link>
        <a href="mailto:hello@curvpad.fun">
          <b>Contact</b>
        </a>
      </span>
    </footer>
  );
}
