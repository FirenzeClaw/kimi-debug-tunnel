import type { Application } from "express";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export function mountConsoleRoute(app: Application, staticDir: string): void {
  const consoleHtmlPath = join(staticDir, "public", "console.html");
  let consoleHtml: string;
  try {
    consoleHtml = readFileSync(consoleHtmlPath, "utf-8");
  } catch {
    consoleHtml = "<html><body><h1>Debug Console not found</h1></body></html>";
  }

  app.get("/", (_req, res) => {
    res.type("html").send(consoleHtml);
  });
}
