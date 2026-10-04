import { QueryClient } from "@tanstack/react-query";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: false },
  },
});
let timer: ReturnType<typeof setTimeout> | undefined;
export function libraryChanged(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["ownership"] });
  }, 150);
}
