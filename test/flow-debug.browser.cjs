'use strict';

// Scene Flow now launches the Native Player through /api/native-play. Keep the
// historical test entry point while the focused Browser-to-Native workflow is
// implemented in its own integration script.
require('./flow-debug-native.browser.cjs');
