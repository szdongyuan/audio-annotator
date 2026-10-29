# Clear file indentation in the audio tree

User requests that audio rows visually read as children of their containing folder. Current nested containers indent by 10px but folder rows additionally add depth * 10px, while media rows do not; deep files appear left of their containing folder label.

Use one consistent indentation model for folder and file rows. Files within a folder should sit one child step deeper, with an understandable guide/disclosure gutter; siblings share a depth. Root files remain compact and names ellipsize at narrow widths. Preserve 28px row heights, batch checkboxes, keyboard navigation, selection/focus scrolling, menus, expansion and folder scoping. No import behavior changes, no new settings or help text.

Backward compatibility: required; protected surfaces all saved project data and existing tree interactions. No format changes or migrations. Verify rendered geometry for at least three nested folder levels and file rows, with and without batch mode, plus existing meaningful tree tests and typecheck. A DOM-only style assertion cannot establish actual browser geometry; inspect a real rendered tree.
