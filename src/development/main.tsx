import { bootstrapApplication } from '../application/bootstrap';
import { FakeApplication } from './FakeApplication';

bootstrapApplication({ developmentApplication: <FakeApplication /> });
