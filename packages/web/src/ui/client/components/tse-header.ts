import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('tse-header')
export class TseHeader extends LitElement {
  @property({ type: Boolean }) building = false;
  @property() statusText = 'Ready';
  @property() statusClass = 'ready';

  createRenderRoot() { return this; }

  render() {
    return html`
      <div class="header-left">
        <h1>HA Forge</h1>
      </div>
      <div class="header-center">
        <button class="btn btn-primary" ?disabled=${this.building}
          @click=${this._onBuild}>Build &amp; Deploy</button>
        <button class="btn" @click=${this._onRegenTypes}>Regen Types</button>
      </div>
      <div class="header-right">
        <span class="status-badge ${this.statusClass}">${this.statusText}</span>
      </div>
    `;
  }

  private _onBuild() {
    this.dispatchEvent(new CustomEvent('tse-build', { bubbles: true, composed: true }));
  }

  private _onRegenTypes() {
    this.dispatchEvent(new CustomEvent('tse-regen-types', { bubbles: true, composed: true }));
  }
}
