import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Moon02Icon, Sun02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";

const KEY = "reelcreel-theme";
const LEGACY_KEY = "yt-downloader-theme";

export function useTheme() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    const initial = stored ? stored === "dark" : true;
    setDark(initial);
    document.documentElement.classList.toggle("dark", initial);
  }, []);

  const toggle = () => {
    setDark((prev) => {
      const next = !prev;
      localStorage.setItem(KEY, next ? "dark" : "light");
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  return { dark, toggle };
}

export function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} title="Toggle theme">
      {dark ? (
        <HugeiconsIcon icon={Sun02Icon} className="h-4 w-4" />
      ) : (
        <HugeiconsIcon icon={Moon02Icon} className="h-4 w-4" />
      )}
    </Button>
  );
}
