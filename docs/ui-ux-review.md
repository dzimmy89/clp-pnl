# UI/UX review against UI/UX Pro Max

The dashboard was checked against the rule set in
[nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
(v2.15: 119 UX guidelines, product reasoning rules, chart and stack guidance), using its search
tool with the product described as a dark, data-dense DeFi portfolio dashboard on Next.js and shadcn.

## What the skill recommended, and the decision

| Area | Recommendation | Decision |
| --- | --- | --- |
| Style | Minimalism / Swiss, dense dashboard spacing; avoid playful design and purple or pink gradients | Already the case. Kept. |
| Colour | Gold-trust primary on a dark slate base | Kept the existing palette: gold `#e2b54a` and azure `#5b93ff` on `#0a0b0e` / `#111318`. Measured contrast: muted text 6.0:1 on cards, gold 9.7:1, azure 6.3:1, destructive 6.3:1, all above the 4.5:1 floor. The suggested purple accent sits on the skill's own avoid list for finance. |
| Typography | Space Grotesk / Inter, or a mono + sans "dashboard data" pairing | Kept Geist Sans + Geist Mono: already a sans + mono pairing with tabular figures for every number, and swapping fonts is taste, not a fix. |
| Charts | Line or area chart for a time series; keyboard access and a text fallback; never meaning by hue alone | Area chart was already in place; added keyboard navigation and a screen-reader summary. |

## Changes made from the audit

- **Reduced motion**: a `prefers-reduced-motion` rule collapses every animation and transition.
- **Keyboard focus**: one global `:focus-visible` ring (2 px, gold, offset) so the hand-rolled tab buttons, chips and text links match the shadcn primitives.
- **Pointer and tap**: `cursor: pointer` and `touch-action: manipulation` on every operable element (Tailwind v4 resets buttons to the default cursor).
- **Skip link** to the main landmark on every page; `scroll-padding-top` so anchored cards and focused controls clear the sticky header.
- **Tab bar at 375 px**: five tabs no longer overflow the pill; it scrolls horizontally with no wrapping.
- **Loading**: the first live read shows placeholders in the headline tiles instead of `$0.00`, and each Liquidity card keeps its height while its history loads; `aria-busy` marks the in-flight regions.
- **Announcements**: fetch and history errors use `role="alert"`; waiting messages use `role="status"`.
- **Target size**: text-only buttons ("Show only…", "Clear filters", in-copy links) get a 24 px minimum height.
- **Show all / Show fewer** buttons expose `aria-expanded`.

## Already passing

Contrast, labelled icon buttons, decorative icons hidden from assistive tech, tables in
`overflow-x-auto` wrappers, formatted numbers, empty states with an action, deep-linked tabs,
disabled Refresh while loading, modal dialogs with escape routes, `max-w-7xl` container.
