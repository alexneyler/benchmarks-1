export interface Provider {
  rank: number;
  provider: string;
  displayName: string;
  score: number;
  logoUrl: string | null;
}

export interface LeaderboardData {
  title: string;
  subtitle: string;
  updatedAt: string;
  providers: Provider[];
}
