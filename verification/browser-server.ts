import { getDb, historyAdd, historyList, putSettings } from "../server/lib/db";
import path from "node:path";
if (!process.env.YTD_DATA_DIR)
  throw new Error("Isolated data directory required");
putSettings({ outputDir: path.join(process.env.YTD_DATA_DIR, "media") });
if (!historyList().length)
  for (let i = 0; i < 245; i++)
    historyAdd({
      id: "fixture-" + i,
      videoId: String(i).padStart(11, "0"),
      title: "Fixture " + i,
      presetId: "mp4-h264",
      completedAt: i,
    });
const { startServer } = await import("../server/index");
startServer();
