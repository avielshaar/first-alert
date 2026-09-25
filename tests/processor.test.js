const { setLastPublished, getLastPublished, getActiveEvents } = require('../src/messaging/processor');

describe('Processor State Management', () => {
    
    // Reset the Processor's memory before each test to prevent state collisions
    beforeEach(() => {
        setLastPublished(null, null, null);
    });

    it('should correctly set and get the last published event', () => {
        setLastPublished('לבנון', 'חיפה, קריות', '14:30');
        const lastPub = getLastPublished();
        
        expect(lastPub).toBeDefined();
        expect(lastPub.source).toBe('לבנון');
        expect(lastPub.target).toBe('חיפה, קריות');
        expect(lastPub.estimated_time).toBe('14:30');
        expect(lastPub.publishedAt).toBeLessThanOrEqual(Date.now());
    });

    it('should clear the last published event when passing null values', () => {
        // Set an alert first
        setLastPublished('עזה', 'שדרות', '12:00');
        
        // Clear it to simulate processor behavior when no data is provided
        setLastPublished(null, null, null);
        
        const lastPub = getLastPublished();
        expect(lastPub).toBeNull();
    });

    it('should return an empty object for active events initially', () => {
        const events = getActiveEvents();
        expect(events).toEqual({});
    });
});