import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

export type PopoverPlacement = "top" | "bottom" | "left" | "right";

interface Props {
  open: boolean;
  onClose: () => void;
  // Element the popover anchors to. Pass either a DOMRect (when the
  // popover is anchored to a transient region like a drag selection)
  // or a ref to a real DOM node. The popover snaps to that node's
  // bounding rect on open and on every scroll/resize.
  anchor: HTMLElement | DOMRect | null;
  placement?: PopoverPlacement;
  children?: ReactNode;
  className?: string;
  // Keep mounted (display:none) so child input focus state survives
  // toggle. Default: unmount.
  keepMounted?: boolean;
}

const GAP_PX = 8;

// Anchored floating panel with click-outside + Esc close. We deliberately
// keep this small + dependency-free instead of pulling in @radix-ui/react-popover
// — the calendar UI uses three popovers (quick-create, event-details,
// calendar-toggle menu) and a few tens of lines is the right size for
// the app.
export function Popover({
  open,
  onClose,
  anchor,
  placement = "bottom",
  children,
  className,
  keepMounted = false,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  // Recompute the position whenever the anchor / placement changes
  // and on scroll/resize so the popover tracks the page layout.
  useLayoutEffect(() => {
    if (!open) return;
    const recompute = () => {
      const rect = anchorRect(anchor);
      const node = ref.current;
      if (!rect || !node) return;
      const nodeRect = node.getBoundingClientRect();
      const next = positionFor(rect, nodeRect, placement);
      setStyle({
        position: "fixed",
        top: `${next.top}px`,
        left: `${next.left}px`,
        zIndex: 60,
        visibility: "visible",
      });
    };
    recompute();
    const handler = () => recompute();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, anchor, placement]);

  // Click-outside: pointerdown on a target that's neither the
  // popover nor (when the anchor is a real element) the anchor
  // itself. Anchored to the document so portalled menus work.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const node = ref.current;
      if (!node) return;
      const target = e.target as Node;
      if (node.contains(target)) return;
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchor]);

  if (!open && !keepMounted) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      style={open ? style : { display: "none" }}
      className={cn(
        "min-w-[14rem] rounded-lg border border-divider bg-background p-3 shadow-xl",
        "focus-visible:outline-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

function anchorRect(anchor: HTMLElement | DOMRect | null): DOMRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return anchor;
}

function positionFor(
  anchor: DOMRect,
  popover: DOMRect,
  placement: PopoverPlacement,
): { top: number; left: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  let top = 0;
  let left = 0;
  switch (placement) {
    case "bottom":
      top = anchor.bottom + GAP_PX;
      left = anchor.left;
      break;
    case "top":
      top = anchor.top - popover.height - GAP_PX;
      left = anchor.left;
      break;
    case "right":
      top = anchor.top;
      left = anchor.right + GAP_PX;
      break;
    case "left":
      top = anchor.top;
      left = anchor.left - popover.width - GAP_PX;
      break;
    default: {
      const _exhaustive: never = placement;
      void _exhaustive;
    }
  }
  // Keep the popover inside the viewport. We don't bother with a
  // collision-detection retry pass — clamping is enough for the
  // calendar surface.
  if (left + popover.width + 8 > vw) left = Math.max(8, vw - popover.width - 8);
  if (left < 8) left = 8;
  if (top + popover.height + 8 > vh) top = Math.max(8, vh - popover.height - 8);
  if (top < 8) top = 8;
  return { top, left };
}
