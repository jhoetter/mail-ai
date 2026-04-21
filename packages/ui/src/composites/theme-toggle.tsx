import { useEffect, useState } from "react";
import { Button } from "../primitives/button.js";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <Button variant="ghost" size="sm" onClick={() => setDark((d) => !d)}>
      {dark ? "Light" : "Dark"}
    </Button>
  );
}
