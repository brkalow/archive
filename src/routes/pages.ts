import { SessionRepository } from "../db/repository";
import { renderStatsPage } from "../views/stats";
import { getDateRange, parsePeriod, fillTimeseriesGaps } from "../analytics/queries";
import { getClientId } from "../utils/request";

export function createPageRoutes(repo: SessionRepository) {
  return {
    /**
     * GET /stats
     * Stats dashboard page
     */
    statsPage(req: Request): Response {
      const url = new URL(req.url);
      const period = parsePeriod(url.searchParams.get("period"));
      const mine = url.searchParams.get("mine") === "true";
      const clientId = mine ? getClientId(req) : undefined;

      const { startDate, endDate } = getDateRange(period);

      // Fetch all data for SSR
      const summary = repo.getStatsSummary(startDate, endDate, clientId ?? undefined);
      const tools = repo.getToolStats(startDate, endDate, clientId ?? undefined);
      const sessionsTimeseries = fillTimeseriesGaps(
        repo.getStatTimeseries("sessions_created", startDate, endDate, clientId ?? undefined),
        startDate,
        endDate
      );

      const html = renderStatsPage({
        period,
        mine,
        summary: {
          sessions_created: summary.sessions_created ?? 0,
          sessions_interactive: summary.sessions_interactive ?? 0,
          sessions_live: summary.sessions_live ?? 0,
          prompts_sent: summary.prompts_sent ?? 0,
          messages_total: summary.messages_total ?? 0,
          tools_invoked: summary.tools_invoked ?? 0,
          subagents_invoked: summary.subagents_invoked ?? 0,
          lines_added: summary.lines_added ?? 0,
          lines_removed: summary.lines_removed ?? 0,
          files_changed: summary.files_changed ?? 0,
        },
        tools,
        timeseries: sessionsTimeseries,
        dateRange: { start: startDate, end: endDate },
      });

      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    },
  };
}
