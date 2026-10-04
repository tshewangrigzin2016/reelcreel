import {
  constants,
  copyFileSync,
  mkdirSync,
  realpathSync,
  statSync,
  rmSync,
} from "node:fs";
import path from "node:path";
export function ownedPath(root: string, candidate: string): string {
  const absolute = path.resolve(candidate);
  const relative = path.relative(realpathSync(root), realpathSync(absolute));
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !statSync(absolute).isFile()
  )
    throw new Error("Output is outside this job's staging directory.");
  return absolute;
}
/** Exclusive copy is atomic with respect to name allocation; existing output is never replaced. */
export function publishFile(
  source: string,
  outputDir: string,
  suffix: string,
  preferredName?: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const name = path.parse(
    preferredName ? path.basename(preferredName) : source,
  );
  for (let n = 0; n < 10000; n++) {
    const filename =
      name.name +
      (n ? " [" + suffix + (n > 1 ? "-" + n : "") + "]" : "") +
      name.ext;
    const destination = path.resolve(outputDir, filename);
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique output filename.");
}

/** Delete only this completed job directory after validating its canonical ownership. */
export function cleanupCompletedStage(outputDir: string, id: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid staging owner.");
  const output = realpathSync(outputDir);
  const root = realpathSync(path.join(output, ".yt-staging"));
  const target = realpathSync(path.join(root, id));
  if (
    root !== path.join(output, ".yt-staging") ||
    target !== path.join(root, id)
  )
    throw new Error("Refusing cleanup outside the job staging directory.");
  rmSync(target, { recursive: true, force: true });
}
