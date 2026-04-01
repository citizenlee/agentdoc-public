export type Theme = 'default' | 'whitey';

export interface ThemePickerOptions {
  defaultTheme?: Theme;
  container?: HTMLElement;
  onChange?: (theme: Theme) => void;
}

export class ThemePicker {
  private currentTheme: Theme;
  private container: HTMLElement | null;
  private onChange?: (theme: Theme) => void;

  constructor(options: ThemePickerOptions = {}) {
    this.currentTheme = options.defaultTheme || this.loadSavedTheme();
    this.container = options.container || null;
    this.onChange = options.onChange;
  }

  init(): void {
    this.applyTheme(this.currentTheme);
    // Don't render the dropdown - theme is controlled from native View menu
    // this.render();
  }

  private loadSavedTheme(): Theme {
    const saved = localStorage.getItem('agentdoc-theme');
    if (saved === 'whitey' || saved === 'default') {
      return saved;
    }
    return 'default';
  }

  private saveTheme(theme: Theme): void {
    localStorage.setItem('agentdoc-theme', theme);
  }

  setTheme(theme: Theme): void {
    this.currentTheme = theme;
    this.applyTheme(theme);
    this.saveTheme(theme);
    this.updateUI();
    this.onChange?.(theme);
  }

  getTheme(): Theme {
    return this.currentTheme;
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }

  private render(): void {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    const themeContainer = document.createElement('div');
    themeContainer.className = 'theme-picker';
    themeContainer.innerHTML = `
      <label for="theme-select">Theme:</label>
      <select id="theme-select">
        <option value="default" ${this.currentTheme === 'default' ? 'selected' : ''}>Default</option>
        <option value="whitey" ${this.currentTheme === 'whitey' ? 'selected' : ''}>Whitey</option>
      </select>
    `;

    toolbar.appendChild(themeContainer);

    const select = document.getElementById('theme-select') as HTMLSelectElement;
    select?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      this.setTheme(target.value as Theme);
    });
  }

  private updateUI(): void {
    const select = document.getElementById('theme-select') as HTMLSelectElement;
    if (select) {
      select.value = this.currentTheme;
    }
  }
}

// Singleton for global access
let themePickerInstance: ThemePicker | null = null;

export function initThemePicker(options?: ThemePickerOptions): ThemePicker {
  if (!themePickerInstance) {
    themePickerInstance = new ThemePicker(options);
    themePickerInstance.init();
  }
  return themePickerInstance;
}

export function getThemePicker(): ThemePicker | null {
  return themePickerInstance;
}
