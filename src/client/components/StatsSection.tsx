/**
 * StatsSection - Homepage statistics display
 *
 * Shows aggregated stats at the bottom of the homepage:
 * - Top models by token usage
 * - Top agents by session count
 * - Most active repositories
 */

import { useState, useEffect } from 'react';

interface TopModel {
  model: string;
  total_tokens: number;
  session_count: number;
}

interface TopAgent {
  harness: string;
  session_count: number;
}

interface ActiveRepo {
  repo_url: string;
  session_count: number;
  total_tokens: number;
}

interface HomepageStats {
  top_models: TopModel[];
  top_agents: TopAgent[];
  most_active_repos: ActiveRepo[];
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
  };
}

// Format large numbers with K/M suffixes
function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

// Extract model short name from full model ID
function getModelShortName(model: string): string {
  // Handle patterns like "claude-sonnet-4-20250514" -> "Sonnet 4"
  // or "claude-opus-4-5-20251101" -> "Opus 4.5"
  const match = model.match(/claude-(\w+)-(\d+(?:-\d+)?)/i);
  if (match) {
    const [, name, version] = match;
    const capitalizedName = name!.charAt(0).toUpperCase() + name!.slice(1);
    const formattedVersion = version!.replace('-', '.');
    return `${capitalizedName} ${formattedVersion}`;
  }
  // Fallback: just return the model name truncated
  return model.length > 20 ? model.slice(0, 17) + '...' : model;
}

// Extract org/repo from GitHub URL
function getRepoShortName(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (match?.[1]) return match[1];
  // Fallback
  return repoUrl.length > 30 ? repoUrl.slice(-27) + '...' : repoUrl;
}

export function StatsSection() {
  const [stats, setStats] = useState<HomepageStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/stats/homepage', {
          credentials: 'include',
        });
        if (!res.ok) {
          if (res.status === 401) {
            // Not authenticated, silently hide stats
            setStats(null);
            return;
          }
          throw new Error('Failed to fetch stats');
        }
        const data = await res.json();
        setStats(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    }

    fetchStats();
  }, []);

  // Don't show anything while loading or if no stats
  if (isLoading) return null;
  if (error) return null;
  if (!stats) return null;

  // Don't show if there's no data
  const hasData =
    stats.top_models.length > 0 ||
    stats.top_agents.length > 0 ||
    stats.most_active_repos.length > 0;

  if (!hasData) return null;

  return (
    <section className="mt-12 pt-8 border-t border-bg-elevated">
      <h2 className="text-sm font-medium text-text-secondary mb-6">Usage Stats</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Top Models */}
        {stats.top_models.length > 0 && (
          <StatCard
            title="Top Models"
            subtitle="by token usage"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            }
          >
            <ul className="space-y-2">
              {stats.top_models.map((model, i) => (
                <li key={model.model} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-text-muted w-4 text-right shrink-0">{i + 1}.</span>
                    <span className="text-text-primary truncate" title={model.model}>
                      {getModelShortName(model.model)}
                    </span>
                  </span>
                  <span className="text-text-muted shrink-0 ml-2">
                    {formatNumber(model.total_tokens)} tokens
                  </span>
                </li>
              ))}
            </ul>
          </StatCard>
        )}

        {/* Top Agents */}
        {stats.top_agents.length > 0 && (
          <StatCard
            title="Top Agents"
            subtitle="by sessions"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          >
            <ul className="space-y-2">
              {stats.top_agents.map((agent, i) => (
                <li key={agent.harness} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-text-muted w-4 text-right shrink-0">{i + 1}.</span>
                    <span className="text-text-primary truncate">{agent.harness}</span>
                  </span>
                  <span className="text-text-muted shrink-0 ml-2">
                    {agent.session_count} session{agent.session_count !== 1 ? 's' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </StatCard>
        )}

        {/* Most Active Repos */}
        {stats.most_active_repos.length > 0 && (
          <StatCard
            title="Most Active Repos"
            subtitle="by sessions"
            icon={
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
              </svg>
            }
          >
            <ul className="space-y-2">
              {stats.most_active_repos.map((repo, i) => (
                <li key={repo.repo_url} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-text-muted w-4 text-right shrink-0">{i + 1}.</span>
                    <a
                      href={repo.repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-primary hover:text-accent-primary truncate transition-colors"
                      title={repo.repo_url}
                    >
                      {getRepoShortName(repo.repo_url)}
                    </a>
                  </span>
                  <span className="text-text-muted shrink-0 ml-2">
                    {repo.session_count} session{repo.session_count !== 1 ? 's' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </StatCard>
        )}
      </div>

      {/* Token totals summary */}
      {stats.totals.total_tokens > 0 && (
        <div className="mt-6 flex items-center justify-center gap-6 text-xs text-text-muted">
          <span>
            <span className="text-text-secondary">{formatNumber(stats.totals.total_tokens)}</span> total tokens
          </span>
          {stats.totals.cache_read_tokens > 0 && (
            <span>
              <span className="text-diff-add">{formatNumber(stats.totals.cache_read_tokens)}</span> cached
            </span>
          )}
        </div>
      )}
    </section>
  );
}

interface StatCardProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function StatCard({ title, subtitle, icon, children }: StatCardProps) {
  return (
    <div className="bg-bg-secondary/50 rounded-lg border border-bg-elevated p-4">
      <div className="flex items-start gap-2 mb-3">
        <div className="text-text-muted mt-0.5">{icon}</div>
        <div>
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <p className="text-xs text-text-muted">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
