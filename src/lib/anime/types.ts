export interface AnimeSearchResult {
  id: string;
  title: string;
  poster: string;
  type: string;
  episodes: {
    sub: number;
    dub: number;
  };
}

export interface AnimeDetails {
  id: string;
  title: string;
  poster: string;
  description: string;
  type: string;
  status: string;
  aired: string;
  genres: string[];
  episodes: {
    sub: number;
    dub: number;
    total: number;
  };
}

export interface Episode {
  number: number;
  id: string;
  title: string | null;
  isFiller: boolean;
}

export interface Server {
  id: string;
  name: string;
  type: "sub" | "dub" | "raw";
}

export interface StreamSource {
  type: "direct" | "embed";
  provider: string;
  m3u8: string | null;
  subtitles: Subtitle[];
  thumbnails: string | null;
  intro: SkipTime | null;
  outro: SkipTime | null;
}

export interface Subtitle {
  lang: string;
  label: string;
  url: string;
}

export interface SkipTime {
  start: number;
  end: number;
}
