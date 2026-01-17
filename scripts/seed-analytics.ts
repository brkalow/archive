/**
 * Seed mock analytics data for testing the stats page.
 * Run with: bun run scripts/seed-analytics.ts
 */

import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";
import type { StatType } from "../src/db/schema";

const db = initializeDatabase();
const repo = new SessionRepository(db);

// Generate dates for the past 14 days
function getRecentDates(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().slice(0, 10));
  }

  return dates;
}

// Random number between min and max
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Seed daily stats
function seedDailyStats() {
  const dates = getRecentDates(14);

  const statTypes: Array<{ type: StatType; minVal: number; maxVal: number }> = [
    { type: "sessions_created", minVal: 3, maxVal: 15 },
    { type: "sessions_interactive", minVal: 1, maxVal: 8 },
    { type: "sessions_live", minVal: 2, maxVal: 10 },
    { type: "prompts_sent", minVal: 20, maxVal: 150 },
    { type: "lines_added", minVal: 100, maxVal: 2000 },
    { type: "lines_removed", minVal: 30, maxVal: 500 },
    { type: "files_changed", minVal: 5, maxVal: 50 },
  ];

  // Tool usage stats
  const tools = [
    { name: "Read", weight: 5 },
    { name: "Edit", weight: 4 },
    { name: "Write", weight: 3 },
    { name: "Bash", weight: 4 },
    { name: "Grep", weight: 3 },
    { name: "Glob", weight: 2 },
    { name: "Task", weight: 1 },
    { name: "WebFetch", weight: 1 },
  ];

  console.log("Seeding daily stats...");

  for (const date of dates) {
    // Weekend factor - less activity on weekends
    const dayOfWeek = new Date(date).getDay();
    const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.4 : 1;

    // Seed core stats
    for (const stat of statTypes) {
      const value = Math.round(rand(stat.minVal, stat.maxVal) * weekendFactor);
      if (value > 0) {
        repo.incrementDailyStat(stat.type, { date, value });
      }
    }

    // Seed tool stats
    for (const tool of tools) {
      const baseValue = rand(5, 30) * tool.weight;
      const value = Math.round(baseValue * weekendFactor);
      if (value > 0) {
        repo.incrementDailyStat(`tool_${tool.name.toLowerCase()}` as StatType, { date, value });
      }
    }
  }

  console.log(`Seeded stats for ${dates.length} days`);
}

// Run seeding
console.log("Starting analytics data seeding...\n");

seedDailyStats();

console.log("\nDone! Visit /stats to see the dashboard.");

db.close();
