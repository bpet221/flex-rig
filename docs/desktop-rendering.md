# How the Claude desktop draws a mod's band (found while restyling the Code work bar)

Read from the desktop app's own bundle (ion-dist.asar, renderer chunk with `function Nf`/`yh`/`Py`), at "comfortable" density:
- Band frame (AbovePrompt) is the app's chrome: min-height 40px, 8px padding, 10px corners, 5% white fill. A mod can't remove it.
- Box numbers: across = `n ch`, down = `n * 0.5lh` (10px). Fractions are accepted (paddingY 0.3 = 3px). Step names map to design tokens.
- Any Box with `borderStyle` gets `padding: 12px 16px` unless that side's padding is set explicitly (set all four).
- Border radius of a bordered Box = radius + 4px = 12px.
- Every Button in the band = 28px control, label 14px, padding 0 10px, `margin-block: -4px` to sit in a 20px line; its hover fill shows the full 28px (that was the overlap). Button label size can't be changed; children Text are flattened to the label.
- A Button `hover={{ backgroundColor: '#00000000' }}` inside a keyed Box beats the built-in hover fill (hover rules are `!important`). 8-digit hex works; 'transparent' does not (becomes currentColor).
- `Select` = 20px rounded field (fill + 1px ring) with caret, pop-up list (position fixed, not clipped) with a check on the current option.
- Text `size="caption"` = 12px/17px. Svg = <img> (or sandboxed iframe with isInteractive); the app injects the host text color, so `currentColor` works.
