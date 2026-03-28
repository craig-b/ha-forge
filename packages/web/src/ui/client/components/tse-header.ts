import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('tse-header')
export class TseHeader extends LitElement {
  @property({ type: Boolean }) building = false;
  @property() statusText = 'Ready';
  @property() statusClass = 'ready';

  @state() private _buildMenuOpen = false;
  @state() private _gearMenuOpen = false;

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._onDocClick = this._onDocClick.bind(this);
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocClick);
  }

  private _onDocClick() {
    if (this._buildMenuOpen) this._buildMenuOpen = false;
    if (this._gearMenuOpen) this._gearMenuOpen = false;
  }

  render() {
    return html`
      <h1>HA Forge</h1>
      <div class="header-actions">
        <button class="btn" @click=${this._onRegenTypes}>Regen Types</button>
        <div class="header-dropdown">
          <button class="btn" @click=${this._toggleBuildMenu}>Build &#9662;</button>
          ${this._buildMenuOpen ? html`
            <div class="header-dropdown-menu">
              <div class="ctx-item" @click=${this._onBuild}>
                Rebuild All
                <div class="ctx-item-desc">Full teardown and redeploy</div>
              </div>
              <div class="ctx-item ctx-danger">
                Undeploy All
                <div class="ctx-item-desc">Remove all entities from HA</div>
              </div>
            </div>
          ` : nothing}
        </div>
      </div>
      <div class="header-right">
        <span class="status-badge ${this.statusClass}">${this.statusText}</span>
        <div class="header-dropdown">
          <button class="header-gear" @click=${this._toggleGearMenu}>&#9881;</button>
          ${this._gearMenuOpen ? html`
            <div class="header-dropdown-menu">
              <div class="ctx-item" @click=${this._onOpenPackages}>Packages</div>
              <div class="ctx-item" @click=${this._onOpenSettings}>Settings</div>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private _toggleBuildMenu(e: Event) {
    e.stopPropagation();
    const opening = !this._buildMenuOpen;
    this._buildMenuOpen = opening;
    this._gearMenuOpen = false;
  }

  private _toggleGearMenu(e: Event) {
    e.stopPropagation();
    const opening = !this._gearMenuOpen;
    this._gearMenuOpen = opening;
    this._buildMenuOpen = false;
  }

  private _onBuild() {
    this.dispatchEvent(new CustomEvent('tse-build', { bubbles: true, composed: true }));
  }

  private _onRegenTypes() {
    this.dispatchEvent(new CustomEvent('tse-regen-types', { bubbles: true, composed: true }));
  }

  private _onOpenPackages() {
    this.dispatchEvent(new CustomEvent('tse-open-packages', { bubbles: true, composed: true }));
  }

  private _onOpenSettings() {
    this.dispatchEvent(new CustomEvent('tse-open-settings', { bubbles: true, composed: true }));
  }
}
