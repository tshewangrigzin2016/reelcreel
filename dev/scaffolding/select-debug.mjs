import { chromium } from "playwright-core";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.getByTitle("Settings").click();
await page.waitForTimeout(600);

const cmp = async (tag) => {
  const domListboxes = await page.evaluate(
    () => document.querySelectorAll('[role="listbox"]').length,
  );
  const pwListboxes = await page.getByRole("listbox").count();
  const pwCombos = await page.getByRole("combobox").count();
  const chain = await page.evaluate(() => {
    const lb = document.querySelector('[role="listbox"]');
    if (!lb) return null;
    const out = [];
    let el = lb;
    while (el && el !== document.documentElement) {
      out.push(`${el.tagName}${el.getAttribute("aria-hidden") ? `[aria-hidden=${el.getAttribute("aria-hidden")}]` : ""}`);
      el = el.parentElement;
    }
    return out.join(" < ");
  });
  console.log(
    `${tag.padEnd(26)} dom=${domListboxes} pwListbox=${pwListboxes} pwCombobox=${pwCombos}`,
  );
  if (chain) console.log(`${" ".repeat(26)} chain: ${chain}`);
};

const trigger = page.getByRole("combobox", { name: "Default fragments" });

await cmp("0 initial");
await trigger.click();
await page.waitForTimeout(500);
await cmp("1 open via trigger.click");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await cmp("2 closed");

await page.getByText("Default fragments", { exact: true }).click();
await page.waitForTimeout(500);
await cmp("3 open via label click");

await browser.close();
