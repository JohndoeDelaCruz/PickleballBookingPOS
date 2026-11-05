"use client";
import { useRef, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { createLandingSmoothScroll } from "@/lib/landing-scroll";
import { prepareLandingStart } from "@/lib/landing-startup";
gsap.registerPlugin(useGSAP, ScrollTrigger);

export function LandingMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      if (!root.current) return;
      prepareLandingStart();
      const element = root.current;
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const destroySmoothScroll = createLandingSmoothScroll();
        const heading = element.querySelectorAll("[data-title-word]");
        const photo = element.querySelector(".hero-image");
        const slideDistance = () =>
          Math.min(88, Math.max(36, window.innerWidth * 0.07));
        const intro = gsap.timeline({ defaults: { ease: "power3.out" } });
        intro
          .from(heading, {
            opacity: 0,
            duration: 1.8,
            stagger: 0.22,
            ease: "sine.out",
            clearProps: "opacity",
          })
          .from(
            ".hero-deck",
            {
              opacity: 0,
              x: slideDistance,
              duration: 0.85,
              clearProps: "opacity,transform",
            },
            0.65,
          )
          .from(
            ".hero-photo",
            {
              opacity: 0.5,
              duration: 1.1,
              clearProps: "opacity",
            },
            "-=.8",
          );
        if (photo)
          gsap.fromTo(
            photo,
            { scale: 1.08, yPercent: -1.5 },
            {
              scale: 1.06,
              yPercent: 1.5,
              ease: "none",
              scrollTrigger: {
                trigger: ".club-hero",
                start: "top bottom",
                end: "bottom top",
                scrub: 1.3,
              },
            },
          );
        gsap.fromTo(".manifesto-image > img", {
          scale: 1.06,
          yPercent: -2,
        }, {
          scale: 1.06,
          yPercent: 2,
          ease: "none",
          scrollTrigger: {
            trigger: ".manifesto-image",
            start: "top bottom",
            end: "bottom top",
            scrub: 0.8,
          },
        });
        element
          .querySelectorAll<HTMLElement>("[data-slide], [data-slide-group]")
          .forEach((container) => {
            // Keep restored scroll positions and direct section links readable.
            if (container.getBoundingClientRect().bottom <= 0) return;
            const grouped = container.hasAttribute("data-slide-group");
            const direction = grouped
              ? container.dataset.slideGroup
              : container.dataset.slide;
            const targets = grouped
              ? Array.from(container.children).filter(
                  (child) => getComputedStyle(child).display !== "none",
                )
              : container;
            // Set the whole group before starting its stagger, avoiding a flash
            // on cards whose individual entrance has not started yet.
            gsap.set(targets, {
              x: direction === "up"
                ? 0
                : slideDistance() * (direction === "left" ? -1 : 1),
              y: direction === "up" ? 30 : 0,
              opacity: 0,
            });
            gsap.to(targets, {
              x: 0,
              y: 0,
              opacity: 1,
              duration: 1.1,
              ease: "power3.out",
              stagger: grouped ? 0.13 : 0,
              clearProps: "opacity,transform",
              scrollTrigger: {
                trigger: container,
                start: "top 91%",
                once: true,
              },
            });
          });
        const focus = (event: FocusEvent) => {
          if (event.target instanceof Element) {
            const container = event.target.closest<HTMLElement>(
              "[data-slide], [data-slide-group]",
            );
            if (container) {
              gsap
                .getTweensOf([container, ...container.children])
                .forEach((tween) => {
                  tween.progress(1);
                  tween.scrollTrigger?.kill();
                });
            }
          }
        };
        element.addEventListener("focusin", focus);
        return () => {
          element.removeEventListener("focusin", focus);
          destroySmoothScroll();
        };
      });
      return () => media.revert();
    },
    { scope: root },
  );
  return (
    <main id="main" className="club-editorial" ref={root}>
      {children}
    </main>
  );
}
