import {
  definePlugin,
  sourceProviderService,
  type SourceProviderService,
} from '../../../src/plugin-sdk/index.js';

const provider: SourceProviderService = {
  id: 'fixture-source',
  async capture(request) {
    return {
      capturedAt: '2026-01-01T00:00:00.000Z',
      facts: { entry: request.entry },
      sourceId: request.reference ?? request.entry,
      sourceType: 'fixture',
    };
  },
};

export default definePlugin({
  manifest: {
    apiVersion: 1,
    capabilities: ['source-provider'],
    id: 'fixture-source',
    provides: { services: [sourceProviderService.id] },
    version: '1.0.0',
  },
  setup(context) {
    context.provide(sourceProviderService, provider);
  },
});
