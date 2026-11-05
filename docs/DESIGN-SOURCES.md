# Public website redesign — design and asset sources

The public website was rebuilt with an independent layout and new presentation imagery. No Ascent photos are used.

Visual references inspected: [Padel Social Club](https://padelsocial.club/) (photographic club atmosphere) and [Rally](https://www.rallypickleball.com/) (sport and social storytelling). These were references only; no source code, text, logos, or images were copied from either site.

The layout now opens with an edge-to-edge photographic hero containing the headline, introduction, and calls to action. A direct reservation form sits immediately below it. The sticky header, looping orange marquee, keyboard-accessible play selector, dark club section, manually controlled gallery, and footer complete the page. Body: Manrope. Display: Archivo Black. Serif: DM Serif Display. Palette: warm paper, charcoal, orange.

Images below were generated with the built-in image-generation tool specifically for this presentation. They depict a fictional concept venue, not the client's real premises. Originals remain in Codex's generated-images directory. Optimized WebP assets are saved in this project:

## public/images/rally-courts.webp (original, replaced in the UI)

Prompt:

Use case: photorealistic-natural. Asset type: wide cinematic hero photograph for a new premium pickleball club website presentation. Primary request: a candid editorial sports photograph at a contemporary outdoor pickleball club in the Philippines, photographed from a slightly elevated courtside viewpoint with the black pickleball net crossing the foreground diagonally, two adult recreational players mid-rally in the middle distance, and sunlit cobalt blue playing surfaces surrounded by warm terracotta runoffs, off-white fencing and lush tropical trees. Clearly pickleball: compact solid paddles, small perforated yellow ball, court with non-volley zones; not tennis or padel, no glass walls. Landscape composition, broad panoramic field of view, gorgeous late afternoon side light, long architectural shadows, filmic rich contrast and natural subtle grain, stylish editorial magazine photography, realistic materials and anatomy. Colors: cobalt, burnt orange, muted foliage, warm ivory. No text, no logos, no brand names, no watermarks. This is original illustrative presentation imagery, not a photograph of any existing named venue. Keep upper parts serene and avoid close up faces. Generate wide landscape 3:2 or wider composition.

## public/images/rally-community.webp

Prompt:

Use case: photorealistic-natural. Asset type: portrait editorial supporting photograph for a modern pickleball club website presentation. Primary request: candid courtside view of two adult Filipino friends in their twenties or thirties chatting after a recreational pickleball game, one holding a compact solid pickleball paddle down at their side, seen in three-quarter view, foreground black net and perforated yellow ball on cobalt court surface. Warm terracotta painted runoffs, off-white chain-link fence, tropical foliage and simple pale stucco architecture in the Philippines. Late afternoon directional sunlight, tactile 35mm film character, rich natural contrast, authentic casual athletic clothing in off-white and burnt orange. Stylish but candid rather than posed luxury advertising. Portrait 4:5 composition, faces natural and anatomically correct, no famous people. No text, no logos, no watermark. New original illustration for a fictional presentation club, no reference to any actual named venue.

## public/images/rally-detail.webp

Prompt:

Use case: photorealistic-natural. Asset type: original wide editorial detail photo for a premium pickleball club website. A matte charcoal compact solid pickleball paddle and two small perforated warm yellow pickleballs resting beside a low white net at the edge of a cobalt blue pickleball court with a terracotta-orange runoff. Close low camera angle, harsh beautiful late-afternoon sunlight creates a diagonal net shadow across the textured sport surface. Stylish restrained athletic still life, analog 35mm film character, warm highlights, high detail, authentic real materials, landscape composition 3:2, no people, no text, no logos, no watermark. A new original conceptual club image, not tied to any named real facility.

## public/images/rally-courts-v2.webp

Replaces the original court image in the hero, courtside gallery, and booking calendar. Edited with the built-in image-generation tool to correct the players' direction relative to the net. The original generated PNG is retained in the Codex generated-images directory; this project uses an optimized WebP copy.

Prompt:

Use case: precise-object-edit. Asset type: full-width photographic hero background for a pickleball club website. Edit the supplied concept photograph to correct its impossible sport geometry, while preserving the same premium tropical Philippine club atmosphere, cobalt blue court, terracotta runoffs, lush foliage, pale stucco architecture, natural late-afternoon light, candid sports photography and realistic material texture. Recompose the court and players as needed: camera is just behind one BASELINE, looking LENGTHWISE down ONE rectangular pickleball court. A SINGLE low black net with white top tape stretches from left sideline to right sideline ACROSS the court, perpendicular to its long axis, clearly halfway between the two ends. One adult player stands on the NEAR half with back / three-quarter back to camera, facing and looking toward the net. The other adult player stands on the FAR half beyond the net, facing and looking toward the near player. Both hold compact solid pickleball paddles, realistic relaxed ready-to-rally stances. The sightline of each player points across the net to their opponent; nobody faces sideways away from the playing direction. Coherent symmetric white court lines, clear non-volley zones either side of the net, no extra nets or lines crossing incorrectly, anatomically correct hands and limbs. Wide landscape 16:9 composition, pulled back to show the whole net and coherent court geometry. Place the players and important sport action mainly in the right-middle area, leaving the left third of the image relatively calm with shadowed court and foliage for a website headline to overlay. Keep all important subjects within the central 75% of the image so moderate responsive crops remain usable. No text, no logos, no watermark, no web interface, no baked-in typography. This is fictional concept imagery for a client presentation, not a real venue photograph.

Once the real client's images and identity are available, replace these concept assets and placeholder branding.

## Landing-page motion

The landing page uses [Lenis](https://github.com/darkroomengineering/lenis) for eased mouse-wheel scrolling, synchronized with GSAP ScrollTrigger through a single GSAP ticker. Touch scrolling stays native. Same-page links retain their URL fragments and respect the sticky header's scroll padding; page navigation destroys the smoother. Reduced-motion preferences disable the smoother and the GSAP effects.

The hero and club photograph use small scroll-linked parallax movements. Section entrances are staggered, while keyboard focus immediately reveals any animated container. The marquee keeps its separate pause/resume control. Booking, account, and POS pages use normal scrolling.

The hero's “Good game.” words fade in without translating or rotating. The landing header overlays the photograph: it is transparent at the top and while scrolling up, and becomes white while scrolling down. Its text color follows the section behind it; the open mobile menu stays white for readability. Other pages retain their solid header.

A hard reload of the landing page intentionally starts at the hero and clears the old section fragment. First-party initialization in `src/instrumentation-client.ts` runs before hydration, temporarily suspends browser scroll restoration, then returns control after page startup; user interaction cancels pending resets. It does not add an inline script element to the React layout, avoiding a hydration collision with extension-injected script tags. Fresh direct section links still open their section, and Back/Forward retains the previous position. Landing-page scroll anchoring is disabled so the reveal animations cannot shift the browser's chosen position.

