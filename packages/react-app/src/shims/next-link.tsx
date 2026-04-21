// next/link replacement for non-Next hosts.
//
// The standalone apps/web build uses Next's <Link> for client-side
// navigation. When the bundle is built for a Vite SPA host (hof-os),
// Next's runtime is unwanted weight, so we alias `next/link` to this
// plain <a> wrapper. Same comment as office-ai's shim.

import type { AnchorHTMLAttributes, ReactNode } from "react";

interface Props extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children?: ReactNode;
}

export default function Link({ href, children, ...rest }: Props) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
