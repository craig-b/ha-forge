import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { EntityInfo } from '../types.js';

@customElement('tse-entity-table')
export class TseEntityTable extends LitElement {
  @property({ type: Array }) entities: EntityInfo[] = [];

  createRenderRoot() { return this; }

  render() {
    return html`
      <table class="entity-table">
        <thead>
          <tr>
            <th>Entity ID</th>
            <th>Name</th>
            <th>Type</th>
            <th>State</th>
            <th>Source</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${this.entities.length === 0
            ? html`<tr><td colspan="6" style="text-align:center;color:var(--text-secondary)">No entities registered</td></tr>`
            : this.entities.map((e) => html`
              <tr>
                <td>${e.id}</td>
                <td>${e.name}</td>
                <td>${e.type}</td>
                <td>${String(e.state ?? '')}</td>
                <td>${e.sourceFile ?? ''}</td>
                <td><span class="entity-status ${e.status}">${e.status}</span></td>
              </tr>
            `)}
        </tbody>
      </table>
    `;
  }
}
