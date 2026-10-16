import { Cat } from "@etbm/shared";

export interface Theme {
  dark: boolean;
  ocean: string;
  land: string;
  border: string;
  lake: string;
  countryText: string;
  text: string;
  textMuted: string;
  halo: string;
  markerFill: string;
  markerStroke: string;
  dimLine: string;
  dimMarker: string;
  dimText: string;
  link: string;
  accent: string;
  cat: Record<number, string>;
}

export const LIGHT: Theme = {
  dark: false,
  ocean: "#d9e4ea",
  land: "#f7f5f0",
  border: "#cdc6ba",
  lake: "#d9e4ea",
  countryText: "#a39b8e",
  text: "#24262a",
  textMuted: "#6b6f76",
  halo: "#f7f5f0",
  markerFill: "#ffffff",
  markerStroke: "#26282c",
  dimLine: "#dcd8d0",
  dimMarker: "#c9c4bb",
  dimText: "#b2aca2",
  link: "#8d8a84",
  accent: "#26282c",
  cat: {
    [Cat.LongDistance]: "#e23b41",
    [Cat.Regional]: "#1f74d1",
    [Cat.Coach]: "#14a065",
    [Cat.Bus]: "#9558d1",
  },
};

export const DARK: Theme = {
  dark: true,
  ocean: "#0c1217",
  land: "#192027",
  border: "#36404a",
  lake: "#0c1217",
  countryText: "#4f5a65",
  text: "#e8ecef",
  textMuted: "#9aa3ab",
  halo: "#192027",
  markerFill: "#f6f7f8",
  markerStroke: "#0c1217",
  dimLine: "#2a323a",
  dimMarker: "#3a444e",
  dimText: "#4c5761",
  link: "#7c8791",
  accent: "#f6f7f8",
  cat: {
    [Cat.LongDistance]: "#ff5d62",
    [Cat.Regional]: "#4b9dff",
    [Cat.Coach]: "#34d08a",
    [Cat.Bus]: "#b98bff",
  },
};

export function currentTheme(): Theme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? DARK : LIGHT;
}
