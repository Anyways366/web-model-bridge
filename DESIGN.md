# Design System: web-model-bridge

## 1. Visual Theme & Atmosphere

web-model-bridge's interface is an infrastructure control panel — quiet, focused, and technically precise. The design communicates reliability and transparency: this is a bridge you trust with your AI traffic. Inspired by Vercel's developer-tooling aesthetic but warmer, borrowing a subtle indigo accent that references the AI domain without feeling cold or corporate.

The canvas is a deep charcoal (`#09090b`) — not pure black, preserving a whisper of warmth that prevents eye fatigue during extended use. Content lives on slightly elevated surfaces (`#111113`) separated by hairline borders using the shadow-as-border technique. The overall feeling is a well-organized command center: every element has a clear purpose, nothing decorative, nothing wasted.

The accent system uses a single indigo hue (`#6366f1`) for interactive elements and status indicators. Green (`#22c55e`) signals authenticated/healthy states. Red (`#ef4444`) signals errors or unauthenticated states. This three-color semantic system — indigo for action, green for success, red for attention — is the entire chromatic vocabulary.

**Key Characteristics:**
- Deep charcoal canvas (`#09090b`) with elevated card surfaces (`#111113`)
- Single accent: Indigo (`#6366f1`) for all interactive elements
- Shadow-as-border: `0 0 0 1px` box-shadows replace traditional borders
- System font stack: -apple-system → Inter → sans-serif (no custom fonts needed)
- Monospace for technical values: SF Mono → Fira Code → Consolas
- Strict 3-color semantic: indigo (action), green (ok), red (attention)
- 8px base spacing unit, 12px standard radius

## 2. Color Palette & Roles

### Primary
- **Canvas** (`#09090b`): Page background — deep charcoal, near-black with warmth
- **Surface** (`#111113`): Cards, containers, elevated panels
- **Surface Hover** (`#1a1a1f`): Hover state for interactive surfaces

### Accent
- **Indigo** (`#6366f1`): Primary interactive — buttons, links, active states
- **Indigo Hover** (`#818cf8`): Hover state for indigo elements
- **Indigo Muted** (`rgba(99, 102, 241, 0.12)`): Tinted backgrounds for badges, highlights

### Semantic
- **Green** (`#22c55e`): Success, authenticated, healthy, active
- **Green Muted** (`rgba(34, 197, 94, 0.15)`): Tinted background for success badges
- **Red** (`#ef4444`): Error, unauthenticated, failed
- **Red Muted** (`rgba(239, 68, 68, 0.12)`): Tinted background for error states
- **Yellow** (`#eab308`): Warning, expired, attention needed

### Neutrals
- **Text Primary** (`#e4e4e7`): Headings, primary content
- **Text Secondary** (`#a1a1aa`): Descriptions, secondary content
- **Text Muted** (`#52525b`): Timestamps, metadata, disabled
- **Border** (`#1f1f23`): Card borders, dividers (via shadow-as-border)
- **Border Hover** (`#2a2a30`): Hovered borders

### Shadows
- **Border Shadow**: `0 0 0 1px #1f1f23` — replaces all traditional borders
- **Card Shadow**: `0 0 0 1px #1f1f23, 0 2px 4px rgba(0,0,0,0.2)`
- **Elevated Shadow**: `0 0 0 1px #1f1f23, 0 4px 12px rgba(0,0,0,0.3)` — modals, dropdowns

## 3. Typography Rules

### Font Families
- **Primary**: `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif`
- **Monospace**: `'SF Mono', 'Fira Code', 'Consolas', 'Liberation Mono', monospace`

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Use |
|------|------|--------|-------------|----------------|-----|
| Page Title | 18px | 600 | 1.3 | -0.02em | Dashboard header, section titles |
| Section Heading | 13px | 600 | 1.3 | 0.05em | Card headers (uppercase) |
| Body | 14px | 400 | 1.5 | normal | Descriptions, provider names |
| Body Medium | 14px | 500 | 1.5 | normal | Interactive text, nav items |
| Code / URL | 14px (mono) | 400 | 1.5 | normal | API URLs, model IDs |
| Label | 12px | 500 | 1.3 | 0.03em | Status labels, badges |
| Caption | 11px | 400 | 1.3 | 0.02em | Hints, footnotes, metadata |

### Principles
- **Compact, not cramped**: 14px base size with 1.5 line-height keeps the interface dense but readable
- **Weight for hierarchy, not size**: Headings use 600 weight at the same or slightly larger sizes — hierarchy comes from weight and caps, not dramatic size jumps
- **Monospace for values**: Any technical value (URLs, model IDs, status codes) uses the mono stack
- **Uppercase for section labels**: Card headers use uppercase + letter-spacing as a structural marker

## 4. Component Stylings

### Buttons

**Primary (Indigo)**
- Background: `#6366f1`
- Text: `#ffffff`
- Padding: 6px 16px
- Radius: 8px
- Hover: `#818cf8`
- Transition: `background 0.15s ease`
- Use: Primary actions (Copy, Login)

**Ghost (Outline)**
- Background: `transparent`
- Text: `#6366f1`
- Border: `1px solid #6366f1`
- Padding: 5px 14px
- Radius: 8px
- Hover: background `#6366f1`, text `#ffffff`
- Transition: `all 0.15s ease`
- Use: Secondary actions (Login buttons on provider rows)

**Danger**
- Background: `transparent`
- Text: `#ef4444`
- Border: `1px solid #ef4444`
- Hover: background `#ef4444`, text `#ffffff`
- Use: Destructive actions (Logout)

### Cards
- Background: `#111113`
- Border: via shadow `0 0 0 1px #1f1f23`
- Radius: 12px
- Header: 16px padding, bottom border via `1px solid #1f1f23`
- Body: 20px padding
- Header text: 13px, weight 600, uppercase, letter-spacing 0.05em, color `#e4e4e7`

### Status Indicators
- Shape: 8px circle
- Active: `#22c55e` with `box-shadow: 0 0 8px rgba(34, 197, 94, 0.4)` glow
- Inactive: `#ef4444` with 0.7 opacity
- Expired: `#eab308`
- Pulse animation on active: `opacity 1 → 0.5 → 1` over 2s

### URL Display Box
- Background: `#09090b` (canvas, recessed from card surface)
- Border: `1px solid #1f1f23`
- Radius: 8px
- Padding: 10px 14px
- Text: monospace, `#6366f1` (indigo for emphasis)
- Layout: flex row, code left, copy button right
- `user-select: all` on the code element for easy selection

### Provider Row
- Layout: flex row, space-between
- Padding: 14px 0
- Bottom border: `1px solid #1f1f23` (last-child: none)
- Left: status dot + name (14px, 500) + id (12px, muted)
- Right: model badge or login button
- No hover background change (rows are informational, not clickable)

### Model Badge
- Background: `rgba(99, 102, 241, 0.12)` (indigo muted)
- Text: `#a1a1aa` (secondary)
- Padding: 2px 10px
- Radius: 6px
- Font: 12px, weight 500

### Toast Notification
- Position: fixed, bottom-right (24px offset)
- Background: `#6366f1` (indigo)
- Text: `#ffffff`
- Padding: 10px 20px
- Radius: 8px
- Shadow: `0 4px 12px rgba(0,0,0,0.3)`
- Animation: fade-in + slide-up (translateY 10px → 0), 0.3s ease
- Auto-dismiss: 2 seconds

### Stats Grid
- 3-column grid (2-column on mobile < 640px)
- Item: card-like with `#09090b` background, `1px solid #1f1f23` border, 12px padding
- Label: 11px, uppercase, muted, letter-spacing 0.05em
- Value: 22px, weight 700
- Green value: `#22c55e` (for "healthy" status)

## 5. Layout Principles

### Spacing Scale (8px base)
- 4px: tight internal padding
- 8px: icon gaps, tight margins
- 12px: standard internal padding
- 16px: card header/body padding
- 20px: card body padding, section gaps
- 24px: container horizontal padding, toast offset
- 32px: between major sections

### Container
- Max-width: 800px
- Centered with auto margins
- Horizontal padding: 20px (12px on mobile)

### Page Structure
- Sticky top bar: surface background, bottom border, 56px height
- Main content: vertical card stack with 20px gaps
- Footer: centered, muted text, top border

### Responsive Breakpoints
- **Desktop** (> 640px): 3-column stats grid, full padding
- **Mobile** (≤ 640px): 2-column stats grid, reduced padding (12px container, 12px topbar)

## 6. Depth & Elevation

### Layer System
1. **Canvas** (`#09090b`): Page background, recessed surfaces (URL boxes, stat items)
2. **Surface** (`#111113`): Cards, top bar — primary content layer
3. **Elevated** (`#1a1a1f`): Hover states, dropdowns, modals
4. **Overlay**: Toast notifications (indigo background, strong shadow)

### Shadow Strategy
- **No visible drop shadows on cards** — depth comes from surface color difference alone
- **Shadow-as-border** (`0 0 0 1px`) for all containment — cleaner than CSS borders
- **Glow on status indicators** — the only "decorative" shadow, used for alive/active feedback
- **Toast shadow** — strong shadow for floating overlay elements

## 7. Do's and Don'ts

### Do
- Use shadow-as-border (`box-shadow: 0 0 0 1px`) instead of `border`
- Use indigo only for interactive elements — never for decoration
- Use monospace font for any technical value the user might copy
- Keep status indicators consistent: green=ok, red=bad, yellow=warning
- Use uppercase + letter-spacing for section headers

### Don't
- Don't use more than 3 semantic colors (indigo, green, red + yellow for warnings)
- Don't add gradients — depth comes from surface layering
- Don't use font sizes larger than 18px — this is a utility interface, not a marketing page
- Don't use opacity below 0.7 for text — maintain readability
- Don't animate anything except status pulse and toast appearance
- Don't use rounded corners larger than 12px

## 8. Responsive Behavior

### Breakpoint: 640px

| Element | Desktop | Mobile |
|---------|---------|--------|
| Stats grid | 3 columns | 2 columns |
| Container padding | 20px | 12px |
| Topbar padding | 16px 24px | 12px 16px |
| Card padding | 20px | 16px |

### Touch Targets
- Minimum button size: 36px height
- Provider login button: 32px height (acceptable — finger-friendly padding from row)
- Copy button: 30px height (within URL box, generous click area)

## 9. Agent Prompt Guide

**Quick color references:**
- Background: `#09090b`, Surface: `#111113`, Border: `#1f1f23`
- Accent: `#6366f1`, Success: `#22c55e`, Error: `#ef4444`
- Text: `#e4e4e7`, Secondary: `#a1a1aa`, Muted: `#52525b`

**Ready-to-use prompt:**
"Build a dark-theme dashboard page following DESIGN.md. Use the canvas/surface/border color system. Cards have 12px radius with shadow-as-border (0 0 0 1px #1f1f23). Buttons are 8px radius, indigo (#6366f1) for primary. Status dots are 8px circles: green (#22c55e) with glow for active, red (#ef4444) for inactive. Monospace font for URLs and technical values. 800px max-width container. System font stack."
