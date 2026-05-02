import { defineConfig } from "vitepress";

export default defineConfig({
  title: "VisualAutoAnnotator",
  description: "On-prem visual annotation editor with YOLO + SAM 2 auto-annotation.",
  base: "/docs/",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Getting started", link: "/getting-started" },
      { text: "Tools", link: "/tools" },
      { text: "Exports", link: "/exports" },
      { text: "Admin", link: "/admin" },
      { text: "SAM 3.1", link: "/sam3p1" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Annotation tools", link: "/tools" },
          { text: "Imports & exports", link: "/exports" },
          { text: "Admin & operations", link: "/admin" },
          { text: "SAM 3.1 Inference", link: "/sam3p1" },
        ],
      },
    ],
    socialLinks: [],
  },
});
