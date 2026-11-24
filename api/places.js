const CATEGORY_TYPES = {
  Food: ['restaurant', 'bakery', 'fast_food_restaurant'],
  Cafe: ['cafe'],
  Movies: ['movie_theater'],
  Shopping: ['shopping_mall', 'department_store', 'clothing_store'],
  Adventure: ['amusement_park', 'bowling_alley', 'tourist_attraction'],
  Entertainment: ['amusement_park', 'bowling_alley', 'movie_theater', 'aquarium', 'zoo'],
  Nature: ['national_park', 'park', 'hiking_area', 'zoo'],
  Sightseeing: ['tourist_attraction', 'museum', 'historical_landmark', 'art_gallery'],
  Beach: ['tourist_attraction', 'park'],
  Parks: ['park'],
  Other: ['tourist_attraction'],
}

const number = (v, min, max) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) return res.status(503).json({ error: 'Google Places is not configured; use OpenStreetMap results.' })

  const { lat, lng, radiusKm, categories, query } = req.body || {}
  if (!number(lat, -90, 90) || !number(lng, -180, 180) || !number(radiusKm, 1, 50)) return res.status(400).json({ error: 'A valid center and radius are required.' })
  const selected = Array.isArray(categories) ? [...new Set(categories.filter((c) => Object.hasOwn(CATEGORY_TYPES, c)))] : []
  const includedTypes = [...new Set(selected.flatMap((c) => CATEGORY_TYPES[c]))]
  const textQuery = typeof query === 'string' ? query.trim().slice(0, 100) : ''
  if (!includedTypes.length && !textQuery) return res.status(400).json({ error: 'Choose an activity category or enter a search.' })

  const nearby = !!includedTypes.length
  const endpoint = nearby ? 'searchNearby' : 'searchText'
  const body = nearby
    ? { includedTypes, maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: Number(lat), longitude: Number(lng) }, radius: Number(radiusKm) * 1000 } } }
    : { textQuery, maxResultCount: 20, locationBias: { circle: { center: { latitude: Number(lat), longitude: Number(lng) }, radius: Number(radiusKm) * 1000 } } }
  // Reviews text is intentionally omitted. Rating + count + hours/address are Enterprise fields;
  // requesting reviews text would raise each query to Enterprise + Atmosphere.
  const fieldMask = 'places.id,places.displayName,places.primaryTypeDisplayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.regularOpeningHours,places.currentOpeningHours,places.priceLevel,places.googleMapsUri'

  try {
    const upstream = await fetch(`https://places.googleapis.com/v1/places:${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(17000),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status === 429 ? 429 : 502).json({ error: data.error?.message || 'Google Places search failed.' })
    const places = (data.places || []).map((p) => ({
      id: p.id,
      name: p.displayName?.text || 'Unnamed place',
      category: p.primaryTypeDisplayName?.text || 'Place',
      address: p.formattedAddress || null,
      latlng: p.location ? [p.location.latitude, p.location.longitude] : null,
      rating: Number.isFinite(p.rating) ? p.rating : null,
      reviews: Number.isFinite(p.userRatingCount) ? p.userRatingCount : null,
      priceLevel: p.priceLevel || null,
      openingHours: p.regularOpeningHours?.weekdayDescriptions || null,
      openNow: typeof p.currentOpeningHours?.openNow === 'boolean' ? p.currentOpeningHours.openNow : null,
      googleMapsUri: p.googleMapsUri || null,
      source: 'Google Places',
      distanceKm: p.location ? distanceKm(Number(lat), Number(lng), p.location.latitude, p.location.longitude) : Infinity,
    })).filter((p) => {
      if (!p.latlng?.every(Number.isFinite) || p.distanceKm > Number(radiusKm)) return false
      // Enforce category semantics after provider search, so adjacent named businesses cannot leak in.
      if (selected.includes('Parks')) return p.category.toLowerCase() === 'park'
      if (selected.includes('Cafe')) return /cafe|coffee shop/.test(p.category.toLowerCase())
      if (selected.includes('Movies')) return /movie theater|cinema/.test(p.category.toLowerCase())
      if (selected.includes('Food')) return /restaurant|bakery|fast food/.test(p.category.toLowerCase())
      return true
    })
    return res.status(200).json({ places, source: 'Google Places' })
  } catch {
    return res.status(504).json({ error: 'Place provider timed out. Retry or use OpenStreetMap results.' })
  }
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (n) => (n * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
