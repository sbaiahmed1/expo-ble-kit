import { registerRootComponent } from 'expo';

// Background tasks must be defined at module scope, before anything renders (P3-04).
import './src/background/scanTask';
import './src/background/restorationTask';
import './src/background/presenceTask';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
