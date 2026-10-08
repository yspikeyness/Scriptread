// Shows a scene's lines and keeps the current one highlighted and centered. Used by Rehearse and Record.
import { t } from './i18n.js';

export class ScriptFollower {
  constructor(container, { onLineClick = null } = {}) {
    this.container = container;
    this.onLineClick = onLineClick;
    this.rows = new Map(); // element index -> row element
  }

  render(elements, scene, userCharacter) {
    this.container.innerHTML = '';
    this.rows.clear();
    if (!scene) return;
    for (let i = scene.start; i < scene.end; i++) {
      const el = elements[i];
      const row = document.createElement('div');
      row.className = `r-el ${el.type}`;
      if (el.type === 'dialogue') {
        const mine = el.speaker === userCharacter;
        if (mine) row.classList.add('mine');
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = mine ? t('{name} (you)', { name: el.speaker }) : el.speaker;
        row.appendChild(who);
        for (const part of el.parts) {
          const span = document.createElement('span');
          span.className = part.kind;
          span.textContent = part.text + ' ';
          row.appendChild(span);
        }
        if (this.onLineClick) {
          row.classList.add('clickable');
          row.title = t('Start from this line');
          // Reachable from the keyboard too: Tab to a line, then Enter.
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.addEventListener('click', () => this.onLineClick(i));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              this.onLineClick(i);
            }
          });
        }
      } else {
        row.textContent = el.text;
      }
      this.rows.set(i, row);
      this.container.appendChild(row);
    }
  }

  highlight(index) {
    for (const [i, row] of this.rows) {
      row.classList.toggle('current', i === index);
      row.classList.toggle('done', index !== null && i < index);
    }
    const row = this.rows.get(index);
    if (row) {
      // Scroll only the panel itself, never the whole window.
      // The container is position: relative, so offsetTop is measured from its top.
      const top = row.offsetTop - (this.container.clientHeight - row.offsetHeight) / 2;
      this.container.scrollTo({ top, behavior: 'smooth' });
    }
  }
}
