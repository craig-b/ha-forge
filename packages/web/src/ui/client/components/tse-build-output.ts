import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { BuildStep } from '../types.js';

@customElement('tse-build-output')
export class TseBuildOutput extends LitElement {
  @property({ type: Array }) steps: BuildStep[] = [];
  @property({ type: Array }) messages: string[] = [];

  createRenderRoot() { return this; }

  render() {
    return html`
      ${this.messages.map((msg) => html`
        <div class="build-step">${msg}</div>
      `)}
      ${this.steps.map((step) => html`
        <div class="build-step">
          <span class="step-icon ${step.success ? 'ok' : 'fail'}">
            ${step.success ? '\u2713' : '\u2717'}
          </span>
          <span class="step-name">${step.step}</span>
          <span class="step-duration">${step.duration}ms</span>
          ${step.error ? html`<span class="step-error">${step.error}</span>` : ''}
        </div>
      `)}
    `;
  }
}
