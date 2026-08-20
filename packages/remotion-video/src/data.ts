export interface Provider {
  rank: number;
  provider: string;
  displayName: string;
  score: number;
  logoUrl: string | null;
}

export interface Sponsor {
  name: string;
  logoUrl: string;
}

export interface LeaderboardData {
  title: string;
  updatedAt: string;
  providers: Provider[];
  sponsors: Sponsor[];
}
